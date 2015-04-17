var util = require('util');

var constants = {};

constants.REQUIRED_DESIGN_DOC_VERSION = '1.0.0';
constants.DESIGN_DOC_NAME = 'savemyseat';
constants.DESIGN_DOC_VIEW_NAME = 'nonDesignDocs';
constants.DESIGN_DOC_FILTER_NAME = 'nonDesignDocs';

constants.DESIGN_DOC_ID = util.format('_design/%s', constants.DESIGN_DOC_NAME);
constants.REPLICATION_FILTER = util.format('%s/%s', constants.DESIGN_DOC_NAME, constants.DESIGN_DOC_FILTER_NAME);
constants.DESIGN_DOC = {
  _id: "_design/savemyseat",
  version: constants.REQUIRED_DESIGN_DOC_VERSION,
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

module.exports = constants;
