const https = require('https');
const ProtoBuf = require('protobufjs');

const nsBuilder = ProtoBuf.loadProtoFile("lib/protos/nyct-subway.proto");
const nstrDecoder = nsBuilder.build("transit_realtime").FeedMessage;
const grssBuilder = ProtoBuf.loadProtoFile("lib/protos/gtfs-realtime-service-status.proto");
const nsssDecoder = grssBuilder.build("transit_realtime").FeedMessage;

/**
 * This is the meat-and-potatoes of the app. The datacache will make
 * periodic requests to the MTA GTFS feeds, parse the data, and extract
 * which lines are in DELAY status and which are not.
 * From that, it will maintain uptime/downtime numbers for each line,
 * and will provide current status and uptime ratio upon being called.
 */

/**
 * Refresh every 59 seconds, so as to avoid the 60-second staleness
 * requirement of the feed.
 */
const REFRESH_INTERVAL = 59 * 1000;

// List of NYC MTA subway GTFS feeds.
const FEED_IDS = [
  'camsys%2Fsubway-alerts'           // As it turns out, we only need the alerts feed.
/*
  'camsys%2Fsubway-alerts',
  'nyct%2fgtfs',
  'nyct%2fgtfs-l',
  'nyct%2fgtfs-nqrw',
  'nyct%2fgtfs-bdfm',
  'nyct%2fgtfs-ace',
  'nyct%2fgtfs-7',
  'nyct%2fgtfs-jz',
  'nyct%2fgtfs-g'
  'nyct%2Fgtfs-si'
*/
];

const SUBWAY_LINES = [
  '1','2','3','4','5','6','7',
  'A','B','C','D','E','F','G','J','L','M','N','Q','R','W','Z',
  'SI'
];
  

/**
 * Make an HTTPS request to the MTA GTFS API for a given feed.
 * @param  {String} baseUrl    - base URL for MTA GTFS API
 * @param  {String} feedId     - identifier for which realtime feed
 * @param  {String} apiKey     - key for MTA GTFS API
 * @return {Promise<Object>}   - Promise of parsed feed.
 */
function makeRequest(baseUrl, feedId, apiKey) {
  const feedUrl = baseUrl + feedId;
  
  return new Promise((resolve, reject) => {
    const req = https.request(feedUrl,
      { headers: { 'x-api-key': apiKey } },
      (res) => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error('statusCode=' + res.statusCode));
        }
        var data;
        data = [];
        res.on('data', (chunk) => {
          return data.push(chunk);
        });
        return res.on('end', function() {
          var msg;
          data = Buffer.concat(data);
          try {
           msg = nstrDecoder.decode(data)
          } catch (err) {
            try {
              msg = nsssDecoder.decode(data)
            } catch (errb) {
              msg = {};
            }
          }
          resolve(msg);
        });
      }
    );
    req.on('error', (e) => {
      reject(e.message);
    });
    // send the request
    req.end();
  });

}

function initLineData(time) {
  return { 
    activeTime: 0, 
    undelayedTime: 0, 
    lastUpdated: time, 
    status: 'NOT DELAYED' 
  };
}

function refreshData(baseUrl, apiKey, lineData) {
  const linesSeen = {};

  // Match 'Delays' at the beginning of a string, ignoring case.
  const delaysRegExp = new RegExp('^delays\b', 'i');

  Promise.all(FEED_IDS.map((feedId) =>
    makeRequest(baseUrl, feedId, apiKey))
  ).then((results) => {
    const currentTime = new Date().getTime();
    results.forEach((feedMessage) => {
      feedMessage.entity.forEach((feedEntity) => {
//        console.log(feedEntity.alert);
        if (feedEntity.alert && feedEntity.alert.header_text &&
            feedEntity.alert.header_text.translation) {
          const alertHeader = feedEntity.alert.header_text.translation.text;
//          console.log(feedEntity.alert.header_text.translation);
//          console.log(feedEntity.alert.description_text.translation);  

          if (alertHeader != '' && alertHeader.search(delaysRegExp) >= 0) {          
            // Now check which lines are affected.
            feedEntity.alert.informed_entity.forEach((infEntity) => {
              if (infEntity.route_id) {
                linesSeen[infEntity.route_id] = true;
                if (!lineData[infEntity.route_id]) {
                  lineData[infEntity.route_id] = initLineData(currentTime);
                }
                lineData[infEntity.route_id].activeTime +=
                  currentTime - lineData[infEntity.route_id].lastUpdated;
                lineData[infEntity.route_id].lastUpdated = currentTime;
                if (lineData[infEntity.route_id].status == 'NOT DELAYED') {
                  console.log('Line ', infEntity.route_id, ' is experiencing delays');
                }
                lineData[infEntity.route_id].status = 'DELAYED';
              }
            });
          }
        }
      });
    });

    // Now that we've parsed all the feeds, update the subway lines that did
    // _not_ have alerts.
    SUBWAY_LINES.forEach((lineId) => {
      if (!linesSeen[lineId]) {
        const deltaTime = currentTime - lineData[lineId].lastUpdated;
        lineData[lineId].activeTime += deltaTime;
        lineData[lineId].lastUpdated = currentTime;
        if (lineData[lineId].status == 'NOT DELAYED') {
          lineData[lineId].undelayedTime += deltaTime;
        } else {
          console.log('Line ', lineId, ' is now recovered');
        }
        // If we haven't seen a "Delays" alert for this line, then it is not delayed.
        lineData[lineId].status = 'NOT DELAYED';
      }
    });    
  }).catch(() => {/* do nothing */});
}

class DataCache {
  constructor(baseUrl, apiKey) {
    this.lineData = {};
    this.startTime = new Date().getTime();
    SUBWAY_LINES.forEach((lineId) => {
      this.lineData[lineId] = initLineData(this.startTime);
    });
    refreshData(baseUrl, apiKey, this.lineData);
    setInterval(refreshData, REFRESH_INTERVAL, baseUrl, apiKey, this.lineData);
  }
  
  getLines() {
    return SUBWAY_LINES;
  }
  
  getUptime(line) {
    if (!this.lineData[line]) {
      return 'We do not have data on that line.';
    }
    const now = new Date().getTime();
    const deltaTime = now - this.lineData[line].lastUpdated;
    const activeTime = this.lineData[line].activeTime + deltaTime;
    if (activeTime < 1000) {
      return 'We do not have a baseline for this subway line.'
    }
    var undelayedTime = this.lineData[line].undelayedTime;
    if (this.lineData[line].status == 'NOT DELAYED') {
      undelayedTime += deltaTime;
    }
    return (undelayedTime / activeTime).toFixed(3);
  }
  
  getStatus(line) {
    if (!this.lineData[line]) {
      return 'We do not have data on that line.';
    }
    return this.lineData[line].status;
  }
}

module.exports = DataCache;

    