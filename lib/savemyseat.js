var fs = require('fs');
var path = require('path');
var util = require('util');
var url = require('url');
var Q = require('Q');
var _ = require('lodash');
var nanoInit = require('nano');
var couchUtils = require('./couch-utils');

/**
 * Internal API for the Savemyseat toolset
 */
function Savemyseat(nano, rawConfig) {
  this._nano = nano;
  this._rawConfig = rawConfig;
}

/**
 * Load the backup database configuration from a file
 */
Savemyseat.loadConfigFromFile = function(backupDbUrl, backupConfigPath) {
  var nano = nanoInit(backupDbUrl);
  var rawBackupConfig = require(path.resolve(backupConfigPath));
  return new Savemyseat(nano, rawBackupConfig);
};

/**
 * Iterate through each backup database config using promises
 */
Savemyseat.prototype.eachBackupDatabase = function(cb) {
  var self = this;

  return _.reduce(this._rawConfig, function(result, backupDbConfig, backupDbName) {
    return result.then(function() {
      var backupDatabase = new BackupDatabase(self._nano, backupDbName, backupDbConfig);

      return cb(backupDatabase);
    });
  }, Q());
};

Savemyseat.prototype.initializeBackupDatabases = function() {
  return this.eachBackupDatabase(function(backupDb) {
    return backupDb.updateReplicatorEntry();
  });
};

/**
 * Starts the monitoring daemon
 */
Savemyseat.prototype.monitor = function() {
};

var REQUIRED_DESIGN_DOC_VERSION = '1.0.0';

function BackupDatabase(nano, name, config) {
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
BackupDatabase.prototype.verifySourceIsConfiguredCorrectly = function() {
  var self = this;

  var sourceDb = this.sourceDb();
  return couchUtils.loadDocFromDbOrNull(sourceDb, '_design/savemyseat')
    .then(
      function success(designDoc) {
        if(!designDoc) {
          throw new Error(util.format('%s is missing the required design doc', self._config.source));
        }
        if(designDoc.version !== REQUIRED_DESIGN_DOC_VERSION) {
          throw new Error(util.format('The design doc for %s is not at the correct version', self.name));
        }
        return;
      }
    );
};

BackupDatabase.prototype.sourceDb = function() {
  var sourceUrl = this._config.source;
  var parsedUrl = url.parse(sourceUrl);
  if(!parsedUrl.host) {
    return this._nano.use(sourceUrl);
  }
  return nanoInit(sourceUrl);
};

BackupDatabase.prototype.updateReplicatorEntry = function() {
  var self = this;

  // FIXME make this more flexible... load this config from the web interface
  var replicatorDb = this._nano.use('_replicator');
  var replicatorEntryId = self.replicatorEntryId();

  return this.verifySourceIsConfiguredCorrectly()
    .then(
      function success() {
        // Ensure that the backup database exists
        return couchUtils.ensureDbExists(self._nano, self.name);
      }
    )
    .then(
      function success() {
        // Attempt to load the current replicator entry
        return couchUtils.loadDocFromDbOrNull(replicatorDb, replicatorEntryId);
      }
    )
    .then(
      function success(currentBackupDbReplicatorEntry) {
        // Delete the backup db or do nothing
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

BackupDatabase.prototype.replicatorEntryId = function() {
  return util.format('%s-backup', this.name); 
};

BackupDatabase.prototype.generateReplicatorEntry = function() {
  return {
    source: this._config.source,
    target: this.name,
    _id: this.replicatorEntryId(),
    continuous: true,
    filter: 'savemyseat/nonDesignDocs'
  };
};

module.exports = {
  Savemyseat: Savemyseat
};
