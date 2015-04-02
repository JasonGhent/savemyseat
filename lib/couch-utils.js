var Q = require('Q');
var _ = require('lodash');

function loadDocFromDbOrNull(db, docId) {
  var deferred = Q.defer();

  db.get(docId, function(err, body) {
    if(err) {
      // Ignore error if the doc doesn't exist
      if(err.error === 'not_found') {
        return deferred.resolve(null);
      }
      return deferred.reject(err);
    }
    return deferred.resolve(body);
  });

  return deferred.promise;
}

function updateDocInDb(db, docId, body) {
  var deferred = Q.defer();
  db.insert(body, docId, function(err, savedBody) {
    if(err) {
      return deferred.reject(err);
    }
    return deferred.resolve(savedBody);
  });
  return deferred.promise;
}

function ensureDbExists(nano, dbName) {
  return Q.nfcall(nano.db.get, dbName)
    .then(
      function success() {
        return null;
      },
      function error(err) {
        if(err.error !== 'not_found') {
          throw err;
        }
        return Q.nfcall(nano.db.create, dbName);
      }
    );
}

function updateDesignDoc(db, designDocId, designDoc, designDocName, designDocViewName) {

  designDoc = _.cloneDeep(designDoc);

  return loadDocFromDbOrNull(db, designDocId)
    .then(
      function success(currentDesignDoc) {
        currentDesignDoc = currentDesignDoc || {};

        if(currentDesignDoc.version === designDoc.version) {
          return;
        }

        if(currentDesignDoc && currentDesignDoc.version !== designDoc.version) {
          designDoc._rev = currentDesignDoc._rev;
        }

        return updateDocInDb(db, designDocId, designDoc);
      }
    )
    .then(
      function success() {
        return Q.nfcall(db.view, designDocName, designDocViewName, { reduce: true });
      }
    );
}

module.exports = {
  loadDocFromDbOrNull: loadDocFromDbOrNull,
  updateDocInDb: updateDocInDb,
  ensureDbExists: ensureDbExists,
  updateDesignDoc: updateDesignDoc
};
