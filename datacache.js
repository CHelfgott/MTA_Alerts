const https = require('https');
const ProtoBuf = require('protobufjs');
const puppeteer = require('puppeteer');

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
  'nyct%2fgtfs-ace'
//  'camsys%2Fsubway-alerts'           // As it turns out, we only need the alerts feed.
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

// Ideally, we'd pull this from the feeds themselves, but the alerts feed only
// gives alerts for lines with a non-trivial status.
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
function makeGtfsRequest(baseUrl, feedId, apiKey) {
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

/**
 * Scrape the MTA webpage for subway status.
 * @return {Promise<Object>}   - Promise of parsed webpage.
 */
async function scrapePage() {
  const url = 'https://new.mta.info';
  
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  await page.goto(url);
  
  // As it turns out, the accessibility section of the page is more parsable
  // then the horrible asynchronously-rendered blob that the rest of it is.
  // And the puppeteer snapshot even more so.
  const snapshot = await page.accessibility.snapshot();

  /**
   * The accessible version of the website is arranged as follows:
   * <a bunch of stuff>
   * { role: 'heading', name: 'Service Status', level: 3 },
   * <more stuff>
   * { role: 'heading', name: <some service status>, level: 5 },
   * { role: 'button', name: 'Click to open a modal with more information about Subway Line <line>' }
   * < more subway line buttons >
   * < more service status blocks, each with their own headers and line buttons >
   * <other stuff, some of which has level: 2>
   */
  
  var serviceStatusSection = false;
  var heading = '';
  const lineStatus = {};
  snapshot.children.forEach((node) => {
    if (node.role == 'heading' && node.name == 'Service Status') {
      serviceStatusSection = true;
    } else if (serviceStatusSection) {
      if (node.role == 'heading') {
        if (node.level == 5) {
          heading = node.name;
        } else {
          heading = '';
        }
      }
      if (heading && node.role == 'button') {
        const lineMatch = node.name.match(/Subway Line ([\w*])$/)
        if (lineMatch) {
          const line = lineMatch[1];
          if (heading == 'Delays') {
            lineStatus[line] = 'delayed';
          } else {
            lineStatus[line] = 'undelayed';
          }
        }
      }
    }
  });
  await browser.close();
  return lineStatus;
}


// Initial state for subway line data.
function initLineData(time) {
  return { 
    activeTime: 0, 
    undelayedTime: 0, 
    lastUpdated: time, 
    status: 'NOT DELAYED' 
  };
}

const sourceIsGtfsApi = false;

/**
 * Makes an HTTPS request and updates data by line.
 * Whether the call is to the GTFS API or it is just scraping the
 * public webpage is determined by the hard-coded sourceIsGtfsApi flag. 
 * @param  {String} baseUrl    - base URL for MTA GTFS API
 * @param  {String} apiKey     - key for MTA GTFS API
 * @param  {Object} lineData   - dictionary of line data by line id
 */
function refreshData(baseUrl, apiKey, lineData) {
  if (sourceIsGtfsApi) {
  
    // Maintain a dict of subway lines that show up in the feeds.
    const linesSeen = {};

    // Match 'Delays' at the beginning of a string, ignoring case.
    const delaysRegExp = new RegExp('^delays\b', 'i');

    Promise.all(FEED_IDS.map((feedId) =>
      makeGtfsRequest(baseUrl, feedId, apiKey))
    ).then((results) => {
      // Once all the feeds return, check the time; this will be lastUpdated.
      const currentTime = new Date().getTime();
    
      results.forEach((feedMessage) => {
        feedMessage.entity.forEach((feedEntity) => {
          // The alert header text generally starts with an enum-type string.
          if (feedEntity.alert && feedEntity.alert.header_text &&
              feedEntity.alert.header_text.translation) {
            const alertHeader = feedEntity.alert.header_text.translation.text;

            // We only care if the string starts with "Delays".
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
        
          // TODO(chelfgott): This logic may _not_ be accurate. Alerts are provided
          // with an "active_period" field which defines when they start and when
          // they end. So the absence of an alert does not necessarily imply the
          // absence of a delay, although we expect the MTA feed to refresh delay
          // alerts periodically.
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
    
  } else {

    // In this case we'll just scrape the MTA webpage.
    scrapePage().then((lineStatus) => {
      const currentTime = new Date().getTime();
      // Update the delayed lines.
      Object.keys(lineStatus).forEach((line) => {
        if (!lineData[line]) {
          lineData[line] = initLineData(currentTime);
        }
        const deltaTime = currentTime - lineData[line].lastUpdated;
        lineData[line].activeTime += deltaTime;          
        lineData[line].lastUpdated = currentTime;
        if (lineData[line].status == 'NOT DELAYED' &&
            lineStatus[line] == 'delayed') {
          console.log('Line ', line, ' is experiencing delays');
          lineData[line].status = 'DELAYED';
        }
        if (lineStatus[line] == 'undelayed') {
          lineData[line].undelayedTime += deltaTime;
          if (lineData[line].status == 'DELAYED') {
            console.log('Line ', line, ' is experiencing delays');
            lineData[line].status = 'NOT DELAYED';
          }
        }        
      });

    }).catch(() => {/* do nothing */});
    
  }
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

    