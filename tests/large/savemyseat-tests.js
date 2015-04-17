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

  var backupFixtureData = {};

  backupFixtureData[DB_WITH_OLD_SAVEMYSEAT_DESIGN_DOC_NAME] = [
    { 
      _id: '_design/savemyseat',
      version: '0.0.1'
    }
  ];

  couchdbFixture(backupFixtureData).beforeEach(function(backupFixtureContext) {
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

  it("should successfully replicate the source server's databases", function(done) {
    var backupDbWithoutDesignDoc = backupNano.use(DB_WITHOUT_DESIGN_DOC_NAME);
    var backupDbWithDesignDoc = backupNano.use(DB_WITH_DESIGN_DOC_NAME);
    var backupDbWithOldSavemyseatDesignDoc = backupNano.use(DB_WITH_OLD_SAVEMYSEAT_DESIGN_DOC_NAME);

    savemyseat.prepareSourcesForBackup()
      .then(
        function success() {
          // attempt to retrieve a doc that hasn't been replicated yet on the
          // backupdb without a design doc
          return Q.nfcall(backupDbWithoutDesignDoc.get, 'some-fake-document');
        }
      )
      .then(
        function success() {
          assert.fail(null, null, 'should not succeed in retrieving document before replication');
        },
        function error(err) {
          assert.equal(err.error, 'not_found', 'Error should be a "not_found" error');
        }
      )
      .then(
        function success() {
          // attempt to retrieve a doc that hasn't been replicated yet on the
          // backupdb with a design doc
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
          // Initiate the replication
          return savemyseat.initializeDatabaseBackups();
        }
      )
      .then(
        function success() {
          // Wait for replication to complete (.5 seconds for good measure)
          return Q.delay(500);
        }
      )
      .then(
        function success() {
          // attempt to retrieve the doc now that replication has hopefully completed
          return Q.nfcall(backupDbWithoutDesignDoc.get, 'some-fake-document');
        }
      )
      .then(
        function success(doc) {
          // check the values in the doc
          assert.equal(doc[0].random, 'stuff1234');
        }
      )
      .then(
        function success() {
          // attempt to retrieve the doc now that replication has hopefully completed
          return Q.nfcall(backupDbWithDesignDoc.get, 'some-fake-document');
        }
      )
      .then(
        function success(doc) {
          // check the values in the doc
          assert.equal(doc[0].random, 'stuff5678');
        }
      )
      .then(
        function success() {
          // attempt to retrieve the doc now that replication has hopefully completed
          return Q.nfcall(backupDbWithDesignDoc.get, '_design/fake-design-doc');
        }
      )
      .then(
        function success(doc) {
          // check the values in the doc
          assert.fail(null, null, 'should not succeed in replicating the design doc from the source');
        },
        function error(err) {
          assert.equal(err.error, 'not_found');
        }
      )
      .then(
        function success() {
          // attempt to retrieve the design doc that was 0.0.1 but should be 1.0.0 after initialization
          return Q.nfcall(backupDbWithOldSavemyseatDesignDoc.get, '_design/savemyseat');
        }
      )
      .then(
        function success(doc) {
          assert.equal(doc[0].version, '1.0.0');
        }
      )
      .done(
        function success() {
          return done();
        },
        function error(err) {
          return done(err);
        }
      );
  });

  it('should fail to initialize database backups if the source has not been prepared by savemyseat', function(done) {
    savemyseat.initializeDatabaseBackups()
      .done(
        function success() {
          assert.fail(null, null, 'should not succeed in initializing the database because the source is not configured correctly');
        },
        function error(err) {
          assert.equal(err.name, 'DatabaseBackupSourceError');
          return done();
        }
      );
  });


});
