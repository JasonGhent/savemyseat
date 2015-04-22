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
var _ = require('lodash');
var util = require('util');
var request = require('superagent');
var precond = require('precond');
var moment = require('moment');

var GENERAL_ERROR_NOTIFICATION_PERIOD_MINUTES = 15;

/**
 * Notifies pager duty of any changes in service statuses
 */
function PagerDutyNotifier(serviceKey) {
  precond.checkIsString(serviceKey, 'PagerDuty service key is required. Use env var "PAGER_DUTY_SERVICE_KEY"');

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

PagerDutyNotifier.prototype.attachToMonitoringDaemon = function(monitoringDaemon) {
  var self = this;
  monitoringDaemon.on('error-triggered', function(name, messages, id) {
    // Format the error messages so that each message is listed with " quotes
    // around it
    var pagerDutyDescription = util.format(
      'Backups for "%s" are experiencing problems. The following error(s) have occured: "%s"', 
      name, messages.join(', "')
    );

    self.notify(pagerDutyDescription, function(err) {
      if(err) {
        console.error(JSON.stringify(err));
      }
    });

  });

  monitoringDaemon.on('error-resolved', function(name, messages, id) {
    // Don't resolve at the moment... we'll do this later
  });

  var lastGeneralErrorNotification = null;

  // Handle general errors this is if something on the monitoring daemon just
  // malfunctions
  monitoringDaemon.on('error', function(err) {
    if(lastGeneralErrorNotification) {
      var now = moment();
      // if the last general error notification happened less than 15 minutes
      // ago then do nothing
      if(now.diff(lastGeneralErrorNotification, 'minutes') < GENERAL_ERROR_NOTIFICATION_PERIOD_MINUTES) {
        return;
      }
    }
    self.notify('The backup system is in error. It is possible that couchdb has stopped', function(err) {
      lastGeneralErrorNotification = moment();
      if(err) {
        console.error(JSON.stringify(err));
      }
    });
  });
};

module.exports = function(monitoringDaemon) {
  var serviceKey = process.env.PAGER_DUTY_SERVICE_KEY;

  var notifier = new PagerDutyNotifier(serviceKey);
  notifier.attachToMonitoringDaemon(monitoringDaemon);

  return notifier;
};
