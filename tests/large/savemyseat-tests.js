var couchdbFixture = require('couchdb-fixture');
var util = require('util');
var assert = require('chai').assert;
var Savemyseat = require('../../lib/savemyseat').Savemyseat;
var nanoInit = require('nano');
var Q = require('q');

var DB_WITHOUT_DESIGN_DOC_NAME = 'db-without-design-doc';
var DB_WITH_DESIGN_DOC_NAME = 'db-with-design-doc';
var DB_WITH_OLD_SAVEMYSEAT_DESIGN_DOC_NAME = 'db-with-old-savemyseat-design-doc';


describe('Savemyseat', function() {
  var savemyseat = null;
  var sourceCouchdbUrl = null;

  this.timeout(30000);

  var sourceFixtureData = {};
  sourceFixtureData[DB_WITHOUT_DESIGN_DOC_NAME] = [
    {
      _id: 'some-fake-document',
      random: 'stuff1234'
    }
  ];

  sourceFixtureData[DB_WITH_DESIGN_DOC_NAME] = [
    {
      _id: '_design/fake-design-doc',
      stuff: 'in here'
    },
    {
      _id: 'some-fake-document',
      random: 'stuff5678'
    }
  ];

  sourceFixtureData[DB_WITH_OLD_SAVEMYSEAT_DESIGN_DOC_NAME] = [
    { 
      _id: '_design/savemyseat',
      version: '0.0.1'
    }
  ];


  couchdbFixture(sourceFixtureData).beforeEach(function(sourceFixtureContext) {
    sourceCouchdbUrl = sourceFixtureContext.couchdbUrl;
    sourceNano = nanoInit(sourceCouchdbUrl);
  });    

  couchdbFixture({}).beforeEach(function(backupFixtureContext) {
    var backupConfigObj = {};
    backupConfigObj[DB_WITH_DESIGN_DOC_NAME] = {
      source: util.format("%s/%s", sourceCouchdbUrl, DB_WITH_DESIGN_DOC_NAME)
    };
    backupConfigObj[DB_WITHOUT_DESIGN_DOC_NAME] = {
      source: util.format("%s/%s", sourceCouchdbUrl, DB_WITHOUT_DESIGN_DOC_NAME)
    };
    backupConfigObj[DB_WITH_OLD_SAVEMYSEAT_DESIGN_DOC_NAME] = {
      source: util.format("%s/%s", sourceCouchdbUrl, DB_WITH_OLD_SAVEMYSEAT_DESIGN_DOC_NAME)
    };
    
    backupCouchdbUrl = backupFixtureContext.couchdbUrl;
    backupNano = nanoInit(backupCouchdbUrl);
    savemyseat = Savemyseat.loadConfigFromObj(backupCouchdbUrl, backupConfigObj);
  });

  it('should initialize the source database', function(done) {
    var backupDbWithoutDesignDoc = backupNano.use(DB_WITHOUT_DESIGN_DOC_NAME);

    savemyseat.prepareSourcesForBackup()
      .then(
        function success() {
          return Q.nfcall(backupDbWithoutDesignDoc.get, 'some-fake-document');
        }
      )
      .then(
        function success() {
          assert.fail(null, null, 'should not succeed in retrieving document before replication');
        },
        function error(err) {
          assert.equal(err.error, 'not_found');
        }
      )
      .then(
        function success() {
          return savemyseat.initializeDatabaseBackups();
        }
      )
      .then(
        function success() {
          return Q.delay(500);
        }
      )
      .then(
        function success() {
          return Q.nfcall(backupDbWithoutDesignDoc.get, 'some-fake-document');
        }
      )
      .then(
        function success(doc) {
          assert.equal(doc[0].random, 'stuff1234');
        }
      )
      .done(
        function success() {
          return done();
        },
        function error(err) {
          return done(err);
        }
      )
  });
});
