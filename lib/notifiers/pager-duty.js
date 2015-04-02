var _ = require('lodash');
var request = require('superagent');

var constants = require('../constants');
var HEALTHY = constants.HEALTHY;
var UNHEALTHY = constants.UNHEALTHY;

// We use this method of initialization so we can use the constants from above
var EVENT_TYPE_MAP = {};
EVENT_TYPE_MAP[UNHEALTHY] = 'trigger';
EVENT_TYPE_MAP[HEALTHY] = 'resolve';

/**
 * Notifies pager duty of any changes in service statuses
 */
function PagerDutyNotifier(serviceKey) {
  this._serviceKey = serviceKey;

  _.bindAll(this);
}

/**
 * Make a request to the PagerDuty Integration API. 
 *
 * See the following link for documentation:
 * http://developer.pagerduty.com/documentation/integration/events
 *
 * @param {String} eventType One of 'trigger', 'resolve', or 'acknowledge'
 * @param {String} [description] Optional description
 * @param {Function} cb The callback. Called with cb(res). Where res is the
 *                      response from the request
 *
 * Note:
 * At this time this method is intended to handle errors from the requests as
 * opposed to allowing the caller of the method to handle errors
 */
PagerDutyNotifier.prototype.makeIncidentRequest = function(eventType, 
                                                           description, 
                                                           cb) {
  var serviceKey = this._serviceKey;
  var requestPayload = {
    service_key: serviceKey,
    event_type: eventType,
  };

  if(description) {
    requestPayload.description = description;
  }

  request.post('https://events.pagerduty.com/generic/2010-04-15/create_event.json')
    .send(requestPayload)
    .end(function(err, res) {
      if(err) {
        return cb(err);
      }
      if(res.status === 200) {
        // All done! Callback!
        return cb(null, res);
      }
      if(res.status === 403) {
        // 403 means we have made too many api calls... we should do something about it
        return;
      }
      if(res.status === 400) {
        // 400 means the json is invalid... Throw an error this shouldn't happen.
        return;
      }
    });
};

/**
 * Handles trigger incidents. This happens when a healthy service becomes unhealthy
 */
PagerDutyNotifier.prototype.notify = function(description, cb) {
  this.makeIncidentRequest(
    'trigger', 
    description,
    function(err, res) {
      if(err) {
        return cb(err);
      }
      cb();
    }
  );
};

module.exports = function() {
  var serviceKey = process.env.PAGER_DUTY_SERVICE_KEY;

  return new PagerDutyNotifier(serviceKey);
};
