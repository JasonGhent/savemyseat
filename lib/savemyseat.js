var fs = require('fs');
var path = require('path');
var util = require('util');
var url = require('url');
var Q = require('Q');
var _ = require('lodash');
var nanoInit = require('nano');
var couchUtils = require('./couch-utils');

var SAVEMYSEAT_DESIGN_DOC_NAME = 'savemyseat';
var SAVEMYSEAT_DESIGN_DOC_VIEW_NAME = 'nonDesignDocs';
var SAVEMYSEAT_DESIGN_DOC_FILTER_NAME = 'nonDesignDocs';

var SAVEMYSEAT_DESIGN_DOC_ID = util.format('_design/%s', SAVEMYSEAT_DESIGN_DOC_NAME);
var SAVEMYSEAT_REPLICATION_FILTER = util.format('%s/%s', SAVEMYSEAT_DESIGN_DOC_NAME, SAVEMYSEAT_DESIGN_DOC_FILTER_NAME);
var SAVEMYSEAT_DESIGN_DOC = {
  _id: "_design/savemyseat",
  version: REQUIRED_DESIGN_DOC_VERSION,
  views: {
    nonDesignDocs: {
      map: function(doc) {
        // Get a count of all non-design documents
        if(doc._id.substr(0, 1) !== '_') {
          emit(doc._id, null);
        }

      }.toString(),
      reduce: '_count'
    }
  },
  filters: {
    nonDesignDocs: function(doc, req) {
      // Skip design docs
      if(doc._id.substr(0, 1) === '_') {
        return false;
      }
      return true;
    }.toString()
  }
};
var REQUIRED_DESIGN_DOC_VERSION = '1.0.0';

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
Savemyseat.loadConfigFromFile = function(dbBackupUrl, backupConfigPath) {
  var nano = nanoInit(dbBackupUrl);
  var rawBackupConfig = require(path.resolve(backupConfigPath));
  return new Savemyseat(nano, rawBackupConfig);
};

/**
 * Iterate through each backup database config using promises
 */
Savemyseat.prototype.eachDatabaseBackup = function(cb) {
  var self = this;

  return _.reduce(this._rawConfig, function(result, dbBackupConfig, dbBackupName) {
    return result.then(function() {
      var dbBackup = new DatabaseBackup(self._nano, dbBackupName, dbBackupConfig);

      return cb(dbBackup);
    });
  }, Q());
};

Savemyseat.prototype.initializeDatabaseBackups = function() {
  return this.eachDatabaseBackup(function(dbBackup) {
    return dbBackup.updateReplicatorEntry();
  });
};

Savemyseat.prototype.prepareSourcesForBackup = function() {
  return this.eachDatabaseBackup(function(dbBackup) {
    return dbBackup.prepareSource();
  });
};

/**
 * Starts the monitoring daemon
 */
Savemyseat.prototype.monitor = function() {
};


function DatabaseBackupSourceError(message) {
  this.name = 'DatabaseBackupSourceError';
  this.message = message;
}
util.inherits(DatabaseBackupSourceError, Error);

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
  return couchUtils.loadDocFromDbOrNull(sourceDb, SAVEMYSEAT_DESIGN_DOC_ID)
    .then(
      function success(designDoc) {
        if(!designDoc) {
          throw new DatabaseBackupSourceError(util.format('%s is missing the required design doc', self._config.source));
        }
        if(designDoc.version !== REQUIRED_DESIGN_DOC_VERSION) {
          throw new DatabaseBackupSourceError(util.format('The design doc for %s is not at the correct version', self.name));
        }
        return;
      }
    );
};

DatabaseBackup.prototype.sourceDb = function() {
  var sourceUrl = this._config.source;
  var parsedUrl = url.parse(sourceUrl);
  if(!parsedUrl.host) {
    return this._nano.use(sourceUrl);
  }
  return nanoInit(sourceUrl);
};

DatabaseBackup.prototype.updateReplicatorEntry = function() {
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

DatabaseBackup.prototype.replicatorEntryId = function() {
  return util.format('%s-backup', this.name); 
};

DatabaseBackup.prototype.generateReplicatorEntry = function() {
  return {
    source: this._config.source,
    target: this.name,
    _id: this.replicatorEntryId(),
    continuous: true,
    filter: SAVEMYSEAT_REPLICATION_FILTER
  };
};

DatabaseBackup.prototype.prepareSource = function() {
  var self = this;

  var sourceDb = this.sourceDb();

  return couchUtils.loadDocFromDbOrNull(sourceDb, SAVEMYSEAT_DESIGN_DOC_ID)
    .then(
      function success(designDoc) {
        designDoc = designDoc || {};

        // If nothing needs to be fixed
        if(designDoc.version === REQUIRED_DESIGN_DOC_VERSION) {
          // Then do nothing
          return;
        }
        var latestDesignDoc = _.cloneDeep(SAVEMYSEAT_DESIGN_DOC);

        if(designDoc && designDoc.version !== REQUIRED_DESIGN_DOC_VERSION) {
          latestDesignDoc._rev = designDoc._rev;
        }

        return couchUtils.updateDocInDb(sourceDb, SAVEMYSEAT_DESIGN_DOC_ID, latestDesignDoc);
      }
    )
    .then(
      function success() {
        // Trigger indexing by calling the database view
        return Q.nfcall(sourceDb.view, SAVEMYSEAT_DESIGN_DOC_NAME, SAVEMYSEAT_DESIGN_DOC_VIEW_NAME, { reduce: true });
      }
    );
};

module.exports = {
  Savemyseat: Savemyseat
};
