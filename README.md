# savemyseat - A couchdb backup toolset

## Introduction

`savemyseat` is a set of tools that can be used to manage backups for your
couchdb storage. The main tools provided by savemyseat are:

1. Backup Monitoring with PagerDuty
2. Initializing the replicator database

## How `savemyseat` backs up data

`savemyseat` backs up data using couchdb replication. It does not, however,
provide rollback capabilities. The suggested use of this toolset is to
initialize the backups and monitor their continued success with this tool. It
is up to the user to take snapshots of the database in order to satisfy
rollback capabilities.

## Quick Start Guide

`savemyseat` commands require a json file that describes the databases to be
backed up. Before we begin using `savemyseat` we need to create this
configuration file, like so::
    
## Command line interface

### Initialize the replicator database

```
    $ savemyseat initialize database-config.json
```

### Monitor backups

```
    $ savemyseat monitor database-config.json
```
