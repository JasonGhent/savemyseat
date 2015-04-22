/**
 * Copyright 2015 Virtru Corporation
 * 
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 * 
 *        http://www.apache.org/licenses/LICENSE-2.0
 * 
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */
var fs = require('fs');
var path = require('path');
var util = require('util');
var url = require('url');
var events = require('events');
var Q = require('Q');
var uuid = require('uuid');
var _ = require('lodash');
var request = require('superagent');
var nanoInit = require('nano');
var couchUtils = require('./couch-utils');
var constants = require('./constants');


/**
 * Internal API for the Savemyseat toolset
 */
function Savemyseat(nano, dbBackupRepo) {
  this._nano = nano;
  this._dbBackupRepo = dbBackupRepo;
}

/**
 * Load the backup database configuration from a file
 */
Savemyseat.loadConfigFromFile = function(dbBackupUrl, backupConfigPath) {
  var nano = nanoInit(dbBackupUrl);
  var rawBackupConfig = require(path.resolve(backupConfigPath));
  var dbBackupRepo = new DatabaseBackupRepository(nano, rawBackupConfig);
  return new Savemyseat(nano, dbBackupRepo);
};

Savemyseat.loadConfigFromObj = function(dbBackupUrl, backupConfigObj) {
  var nano = nanoInit(dbBackupUrl);
  var dbBackupRepo = new DatabaseBackupRepository(nano, backupConfigObj);
  return new Savemyseat(nano, dbBackupRepo);
};

Savemyseat.prototype.initializeDatabaseBackups = function() {
  return this._dbBackupRepo.each(function(dbBackup) {
    return dbBackup.initialize();
  });
};

Savemyseat.prototype.prepareSourcesForBackup = function() {
  return this._dbBackupRepo.each(function(dbBackup) {
    return dbBackup.prepareSource();
  });
};

/**
 * Starts the monitoring daemon
 */
Savemyseat.prototype.monitor = function(pollIntervalMs, options) {
  var monitoringDaemon = new MonitoringDaemon(this._nano.config.url, this._dbBackupRepo, pollIntervalMs, options);

  monitoringDaemon.start();

  return monitoringDaemon;
};

function ActiveTasks(rawActiveTasks) {
  this._rawActiveTasks = rawActiveTasks;
}
util.inherits(ActiveTasks, events.EventEmitter);

ActiveTasks.loadForDbUrl = function(dbUrl) {
  var deferred = Q.defer();

  request.get(util.format('%s/_active_tasks', dbUrl))
    .set('Accept', 'application/json')
    .end(function(err, res) {
      if(err) {
        return deferred.reject(err);
      }
      return deferred.resolve(new ActiveTasks(res.body));
    });
  return deferred.promise;
};

ActiveTasks.prototype.generateStatusReport = function(dbBackupRepo) {
  var actualRunningBackups = [];
  var self = this;
  var statusReport = {
    docWriteFailures: {},
    backupsNotRunning: []
  };

  var expectedDatabaseBackupTargetNames = dbBackupRepo.getNames();

  _.each(this._rawActiveTasks, function(task) {
    // skip if the task is not a replication task
    if(task.type !== 'replication') {
      return;
    }

    // if the running replication isn't one we care about then skip
    var dbBackup = dbBackupRepo.get(task.target);
    if(expectedDatabaseBackupTargetNames.indexOf(task.target) === -1) {
      return;
    }

    actualRunningBackups.push(task.target);

    if(task.doc_write_failures !== 0) {
      statusReport.docWriteFailures[task.target] = task.doc_write_failures;
    }
  });

  var backupsNotRunning = _.difference(expectedDatabaseBackupTargetNames, actualRunningBackups);
  _.each(backupsNotRunning, function(backupNotRunning) {
    statusReport.backupsNotRunning.push(backupNotRunning);
  });

  return statusReport;
};

function DatabaseBackupRepository(nano, rawConfig) {
  this._nano = nano;
  this._rawConfig = rawConfig;
}

/**
 * Iterate through each of the DatabaseBackup objects
 */
DatabaseBackupRepository.prototype.each = function(cb) {
  var self = this;

  return _.reduce(this._rawConfig, function(result, dbBackupConfig, dbBackupName) {
    return result.then(function() {
      return cb(new DatabaseBackup(self._nano, dbBackupName, dbBackupConfig));
    });
  }, Q());
};

/**
 * Gets the database backup of a given name
 */
DatabaseBackupRepository.prototype.get = function(name) {
  var backupConfig = this._rawConfig[name];
  if(!backupConfig) {
    return null;
  }
  return new DatabaseBackup(name, backupConfig);
};

/**
 * Gets the names of a set of database backups
 */
DatabaseBackupRepository.prototype.getNames = function() {
  return _.keys(this._rawConfig);
};

function DatabaseBackupSourceError(message) {
  this.name = 'DatabaseBackupSourceError';
  this.message = message;

  // Capture the stack and store into .stack
  Error.captureStackTrace(this, arguments.callee);
}
util.inherits(DatabaseBackupSourceError, Error);

/**
 * Abstracts access to a database backup configuration
 */
function DatabaseBackup(nano, name, config) {
  this.name = name;
  this._nano = nano;
  this._config = config;
}

/**
 * Ensures that the source database is prepared to be backed up
 *
 * This includes verifying that the correct design docs are configured on the
 * source and at the correct version
 */
DatabaseBackup.prototype.verifySourceIsConfiguredCorrectly = function() {
  var self = this;

  var sourceDb = this.sourceDb();
  return couchUtils.loadDocFromDbOrNull(sourceDb, constants.DESIGN_DOC_ID)
    .then(
      function success(designDoc) {
        if(!designDoc) {
          throw new DatabaseBackupSourceError(util.format('%s is missing the required design doc', self._config.source));
        }
        if(designDoc.version !== constants.REQUIRED_DESIGN_DOC_VERSION) {
          throw new DatabaseBackupSourceError(util.format('The design doc for %s is not at the correct version. Expected %s. Design Doc @ %s', self.name, constants.REQUIRED_DESIGN_DOC_VERSION, designDoc.version));
        }
        return;
      }
    );
};

/**
 * Return the nano.db of the source database
 */
DatabaseBackup.prototype.sourceDb = function() {
  var sourceUrl = this._config.source;
  var parsedUrl = url.parse(sourceUrl);
  if(!parsedUrl.host) {
    return this._nano.use(sourceUrl);
  }
  return nanoInit(sourceUrl);
};

/**
 * Return the nano.db of the destination (the backup) database
 */
DatabaseBackup.prototype.destDb = function() {
  return this._nano.use(this.name);
};

/**
 * Initializes a database backup configuration
 *
 * This is accomplished in a few steps:
 *
 *   1. Verify that the source database has been configured correctly (correct
 *      design docs)
 *
 *   2. Ensure that the database exists at the destination
 *
 *   3. Update the design docs on the destination database
 *
 *   4. Add a replication document to the replicator database on the
 *      destination couchdb
 */
DatabaseBackup.prototype.initialize = function() {
  var self = this;

  var destDb = this.destDb();
  
  return this.verifySourceIsConfiguredCorrectly()
    .then(
      function success() {
        // Ensure that the backup database exists
        return couchUtils.ensureDbExists(self._nano, self.name);
      }
    )
    .then(
      function success() {
        // Add the design doc
        return couchUtils.updateDesignDoc(
          destDb, 
          constants.DESIGN_DOC_ID, 
          constants.DESIGN_DOC, 
          constants.DESIGN_DOC_NAME, 
          constants.DESIGN_DOC_VIEW_NAME
        );
      }
    )
    .then(
      function success() {
        return self.updateReplicatorEntry();
      }
    );
};

/**
 * Updates the replicator entry on the destination couchdb
 */
DatabaseBackup.prototype.updateReplicatorEntry = function() {
  var self = this;

  // FIXME make this more flexible... load this config from the web interface
  var replicatorDb = this._nano.use('_replicator');
  var replicatorEntryId = self.replicatorEntryId();

  return couchUtils.loadDocFromDbOrNull(replicatorDb, replicatorEntryId)
    .then(
      function success(currentBackupDbReplicatorEntry) {
        // Delete the replicator entry or do nothing
        if(currentBackupDbReplicatorEntry) {
          currentBackupDbReplicatorEntry._deleted = true;

          return couchUtils.updateDocInDb(replicatorDb, replicatorEntryId,
                                          currentBackupDbReplicatorEntry);
        }

        return;
      }
    )
    .then(
      function success() {
        // Save the current replicator entry for this backup
        return couchUtils.updateDocInDb(replicatorDb, replicatorEntryId, 
                                        self.generateReplicatorEntry());
      }
    );
};

/**
 * Get the name for the replicator entry for this database backup
 */
DatabaseBackup.prototype.replicatorEntryId = function() {
  return util.format('%s-backup', this.name); 
};

/**
 * Generate the document to put in the replicator database for this database
 * backup
 */
DatabaseBackup.prototype.generateReplicatorEntry = function() {
  return {
    source: this._config.source,
    target: this.name,
    _id: this.replicatorEntryId(),
    continuous: true,
    filter: constants.REPLICATION_FILTER
  };
};

/**
 * Prepare the source database for replication
 */
DatabaseBackup.prototype.prepareSource = function() {
  var self = this;

  var sourceDb = this.sourceDb();

  return couchUtils.loadDocFromDbOrNull(sourceDb, constants.DESIGN_DOC_ID)
    .then(
      function success(designDoc) {
        designDoc = designDoc || {};

        // If nothing needs to be fixed
        if(designDoc.version === constants.REQUIRED_DESIGN_DOC_VERSION) {
          // Then do nothing
          return;
        }
        var latestDesignDoc = _.cloneDeep(constants.DESIGN_DOC);

        if(designDoc && designDoc.version !== constants.REQUIRED_DESIGN_DOC_VERSION) {
          latestDesignDoc._rev = designDoc._rev;
        }

        return couchUtils.updateDocInDb(sourceDb, constants.DESIGN_DOC_ID, latestDesignDoc);
      }
    )
    .then(
      function success() {
        // Trigger indexing by calling the database view
        return Q.nfcall(sourceDb.view, constants.DESIGN_DOC_NAME, constants.DESIGN_DOC_VIEW_NAME, { reduce: true });
      }
    );
};

/**
 * Get the document counts for both the source and the destination databases
 */
DatabaseBackup.prototype.getSourceAndDestinationDocumentCounts = function() {
  var self = this;

  var destDb = this.destDb();
  var sourceDb = this.sourceDb();

  var sourceCount = null;
  var destCount = null;

  return Q.nfcall(sourceDb.view, constants.DESIGN_DOC_NAME, constants.DESIGN_DOC_VIEW_NAME, { reduce: true })
    .then(
      function success(reduce) {
        sourceCount = reduce[0].rows[0].value;
        return Q.nfcall(destDb.view, constants.DESIGN_DOC_NAME, constants.DESIGN_DOC_VIEW_NAME, { reduce: true });
      }
    )
    .then(
      function success(reduce) {
        destCount = reduce[0].rows[0].value;
        return {
          sourceCount: sourceCount,
          destCount: destCount
        };
      }
    );
};


var defaultBackupStateOptions = {
  documentCountDeltaThreshold: 100
};

function BackupState(options) {
  this._isRunning = true;
  this._docWriteFailures = 0;
  this._documentCountDelta = 0;
  this._isInError = false;
  this._options = options || _.cloneDeep(defaultBackupStateOptions);
  this._uuid = uuid.v4();
}

BackupState.prototype.setAttribute = function(attributeName, value) {
  this['_' + attributeName] = value;
};

BackupState.prototype.evaluateErrorState = function() {
  var errorMessages = [];
  var isInError = false;
  if(!this._isRunning) {
    isInError = true;
    errorMessages.push('Backup is not running');
  }
  if(this._docWriteFailures > 0) {
    isInError = true;
    errorMessages.push('Document write failures are greater than 0');
  }
  if(this._documentCountDelta > this._options.documentCountDeltaThreshold) {
    isInError = true;
    errorMessages.push(util.format(
      'The source contains %d more documents than the backup which is above the threshold of %d',
      this._documentCountDelta,
      this._options.documentCountDeltaThreshold
    ));
  }

  var hasErrorStateChanged = this._isInError !== isInError;

  this._isInError = isInError;

  return {
    isInError: isInError,
    hasErrorStateChanged: hasErrorStateChanged,
    messages: errorMessages,
    uuid: this._uuid
  };
};

/**
 * A backup monitor
 *
 * The monitor emits events that you can choose to track. Events emitted:
 *
 *  `doc-write-failures`
 *    params: (databaseBackup, failedToWriteCount)
 *    description: happens when some documents fail to replicate
 *
 *  `backup-not-running`
 *    params: (databaseBackup)
 *    description: happens when it is found that a database backup is not running
 *
 *  `document-counts`
 *    params: (sourceDocumentCounts, destDocumentCounts)
 *    description: happens at every check status interval. it provides document
 *                 counts for the source and destination
 */
function MonitoringDaemon(dbUrl, dbBackupRepo, pollIntervalMs, options) {
  this._dbUrl = dbUrl;
  this._dbBackupRepo = dbBackupRepo;
  this._timeout = null;
  this._pollIntervalMs = pollIntervalMs || 10000;

  this._options = options;
  this._dbBackupStates = {};
}
util.inherits(MonitoringDaemon, events.EventEmitter);

MonitoringDaemon.prototype.loadActiveTasks = function() {
  return ActiveTasks.loadForDbUrl(this._dbUrl);
};

MonitoringDaemon.prototype.initializeBackupStates = function() {
  var self = this;

  var dbBackupStates = this._dbBackupStates;
  _.each(this._dbBackupRepo.getNames(), function(dbBackupName) {
    dbBackupStates[dbBackupName] = new BackupState(self._options);
  });
};

MonitoringDaemon.prototype.start = function() {
  var self = this;

  // Initialize backup states
  this.initializeBackupStates();

  var dbBackupStates = this._dbBackupStates;

  function checkStatus(done) {
    self.loadActiveTasks()
      .then(
        function success(activeTasks) {
          var statusReport = activeTasks.generateStatusReport(self._dbBackupRepo);
          return statusReport;
        }
      )
      .then(
        function success(statusReport) {
          return self._dbBackupRepo.each(function(dbBackup) {
            var dbBackupState = dbBackupStates[dbBackup.name];
            return dbBackup.getSourceAndDestinationDocumentCounts()
              .then(
                function success(counts) {
                  dbBackupState.setAttribute(
                    'isRunning',
                    statusReport.backupsNotRunning.indexOf(dbBackup.name) === -1
                  );
                  
                  dbBackupState.setAttribute(
                    'docWriteFailures',
                    statusReport.docWriteFailures[dbBackup.name] || 0
                  );

                  dbBackupState.setAttribute(
                    'documentCountDelta', 
                    counts.sourceCount - counts.destCount
                  );


                }
              );
          });
        }
      )
      .then(
        function success() {
          _.each(dbBackupStates, function(dbBackupState, dbBackupName) {
            var errorState = dbBackupState.evaluateErrorState();
            if(errorState.hasErrorStateChanged) {
              if(errorState.isInError) {
                self.emit('error-triggered', dbBackupName, errorState.messages, errorState.uuid);
              } else {
                self.emit('error-resolved', dbBackupName, errorState.messages, errorState.uuid);
              }
            }
          });
        }
      )
      .then(
        function success() {
          return done();
        },
        function error(err) {
          return done(err);
        }
      );
  }

  function next(err) {
    if(err) {
      self.emit('error', err);
    }
    self._timeout = setTimeout(checkStatus.bind(null, next), self._pollIntervalMs);
  }

  checkStatus(next);
};

MonitoringDaemon.prototype.stop = function() {
  clearTimeout(this._timeout);
};

module.exports = {
  Savemyseat: Savemyseat
};
