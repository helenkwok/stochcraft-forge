# Privacy: StochCraft Flow forecast for Jira

Last updated: 21 November 2026.

StochCraft Flow forecast is an Atlassian Forge app that reads the timing of a Jira project's resolved issues and simulates how its flow would change with more demand. This page says what it reads, what it does with it, and what it keeps.

## What the app reads

When you press **Forecast**, the app reads from the Jira project you name, as you, with your own permissions:

- how many issues were created and how many were resolved in the date window you chose;
- for up to 300 of the resolved issues: when each was created, when it was resolved, and when its status changed to an "in progress" status.

It does not read issue titles, descriptions, comments, attachments, assignees, reporters or any account details, and it does not use the names or account ids that Jira includes in an issue's history.

## What the app does with it

The numbers are turned into a queue model and simulated inside a Forge function, which runs on Atlassian's infrastructure (the app is eligible for Atlassian's "Runs on Atlassian" programme). The results are shown to you in the page and are not sent anywhere else.

The app makes no calls to any service outside Atlassian, uses no analytics, and has no tracking.

## What the app keeps

Nothing. The app does not store data: it uses no Forge storage, no database and no logs of its own. The numbers exist for the length of one request. Atlassian's platform keeps its own operational records of function calls, as it does for every Forge app.

## What the app writes

Only when you press **Post to Jira**, the app adds one comment, as you, to the issue you name. The comment holds the forecast's numbers (tables of rates, waiting times and ranges). The app writes nothing else to Jira.

## Permissions

The app asks for two Jira scopes: `read:jira-work`, to read the timings above, and `write:jira-work`, to add the comment when you ask for it.

## Personal data

The app does not copy or store personal data, and it does not keep data for longer than the request that uses it.

## Questions

Questions and requests: https://github.com/helenkwok/StochCraft/issues
