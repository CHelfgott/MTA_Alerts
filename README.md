# MTA_Alerts
This project is an attempt to scrape the NYC MTA real-time feed of subway status alerts.
It will log any change of status from delayed to not-delayed and vice-versa, and will
provide API endpoints to 1) show the current status of a given line, and 2) show the
fractional up-time for a given line since we started scraping the feed.

This project complies with the NYC MTA Terms of Service for accessing their feed and
providing information based on it.
https://api.mta.info/#/DataFeedAgreement

This project _also_ provides an option to directly scrape the new.mta.info website for
the same data instead of using the GTFS feed.  This is sometimes preferable as the two
sources can be out of sync.


## Configuration
Set the following as environment variables:

  * `MTA_KEY` your MTA API KEY
  * `PORT` if you wish to override the default port we listen on (3000)

`Dotenv.load()` is automatic so we'll source these from a standard `.env` file if it exists.
