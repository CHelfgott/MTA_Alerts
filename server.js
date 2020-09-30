const dotenv = require('dotenv');
const express = require('express');
const path = require('path');
const DataCache = require('./datacache');

const app = express();

dotenv.load();
const MTA_KEY     = process.env.MTA_KEY;
const PORT        = process.env.PORT || 3000;
const BASE_URL    = "https://api-endpoint.mta.info/Dataservice/mtagtfsfeeds/";

const dc = new DataCache(BASE_URL, MTA_KEY);

// List active subway lines.
app.get('/lines', function(req, res) {
  res.json(dc.getLines());
});

/**
 * Get status for a given line.
 * Params:
 *   - line      - String - the name of the subway line
 */
app.get('/status/:line', function(req, res) {
  const { line } = req.params;
  res.send(dc.getStatus(line));
});

/**
 * Get uptime fraction for a given line.
 * Params:
 *   - line      - String - the name of the subway line
 */
app.get('/uptime/:line', function(req, res) {
  const { line } = req.params;
  res.send(dc.getUptime(line));
});

server = app.listen(PORT, function() {
  console.log("MTA_Alerts: Listening on port " + server.address().port + "...");
});
