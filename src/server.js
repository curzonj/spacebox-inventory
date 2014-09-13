'use strict';

var http = require("http");
var express = require("express");
var logger = require('morgan');
var bodyParser = require('body-parser');
var uuidGen = require('node-uuid');
var debug = require('debug')('build');

var app = express();
var port = process.env.PORT || 5000;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

var inventories = {};
var blueprints = require('./blueprints');
var facilities = {
    "dummy": {
        "blueprint": "dummy"
    }
};
var spodb = {
    "dummy": {
        "blueprint": "dummy"
    }
};
var buildJobs = {};

app.get('/jobs', function(req, res) {
    res.send(buildJobs);
});

// players cancel jobs
app.delete('/jobs/:uuid', function(req, res) {
    // does the user get the resources back?
    // not supported yet
    res.sendStatus(404);
});

// players queue jobs
app.post('/jobs', function(req, res) {
    var uuid = uuidGen.v1();
    debug(req.body);

    var example = {
        "facility": "uuid",
        "action": "manufacture", // refine, construct
        "quantity": 3,
        "target": "blueprintuuid",
        "inventory": "uuid"
    };

    var job = req.body;
    var facility = facilities[job.facility];
    var facilityType = blueprints[facility.blueprint];
    var canName = "can" + job.action.charAt(0).toUpperCase() + job.action.slice(1);
    var canList = facilityType[canName];
    var target = blueprints[req.body.target];
    var duration = -1;

    if (canList.indexOf(job.target) == -1) {
        res.sendStatus(400);
    }

    if (job.action == "refine") {
        // verify space in the attached inventory after target is removed
        consume(job.inventory, job.target, job.quantity);
        duration = target.refine.time;
    } else {
        duration = target.build.time;

        for (var key in target.build.resources) {
            var count = target.build.resources[key];
            consume(job.inventory, key, count*job.quantity);
        }

        if (job.action == "construct") {
            job.quantity = 1;
        }
    }

    job.finishAt = (new Date().getTime() + duration*1000*job.quantity);
    buildJobs[uuid] = job;
    res.sendStatus(201);
});

app.get('/facilities', function(req, res) {
    res.send(facilities);
});

app.post('/facilities/:uuid', function(req, res) {
    // this is when spodb has an update to an existing
    // facility, not yet supported
    res.sendStatus(404);
});

// spodb tells us when facilities come into existance
app.post('/facilities', function(req, res) {
    var uuid = req.body.uuid || uuidGen.v1();
    debug(req.body);
    var blueprint = blueprints[req.body.blueprint];

    if (blueprint) {
        facilities[uuid] = req.body;
        if (blueprint.type == "structure" || blueprint.type == "deployable") {
            spodb[uuid] = {
                blueprint: uuid
            };
        }

        res.sendStatus(201);
    } else {
        res.sendStatus(400);
    }
});

// this is just a stub until we build the inventory and emit to it
app.get('/inventories', function(req, res) {
    res.send(inventories);
});

// this is just a stub until we build the spodb
app.get('/spodb', function(req, res) {
    res.send(spodb);
});

function consume(uuid, type, quantity) {
    if (inventories[uuid] === undefined) {
        inventories[uuid] = [];
    }

    inventories[uuid].push({
        blueprint: type,
        quantity: quantity * -1
    });
}

function produce(uuid, type, quantity) {
    var obj = {
        blueprint: type,
        quantity: quantity
    };
    debug(obj);

    if (inventories[uuid] === undefined) {
        inventories[uuid] = [];
    }

    inventories[uuid].push(obj);
}

var buildWorker = setInterval(function() {
    var timestamp = new Date().getTime();

    for(var uuid in buildJobs) {
        var job = buildJobs[uuid];
        if (job.finishAt < timestamp && job.finished !== true) {
            debug(job);
            job.finished = true;

            switch (job.action) {
                case "manufacture":
                    produce(job.inventory, job.target, job.quantity);
                    break;
                case "refine":
                    var target = blueprints[job.target];
                    for (var key in target.refine.outputs) {
                        var count = target.refine.outputs[key];
                        produce(job.inventory, key, count*job.quantity);
                    }
                    break;
                case "construct":
                    // in the end this will notify spodb something
                    // was changed and spodb will notify us
                    spodb[job.facility].blueprint = job.target;

                    break;
            }
        
        }
    }
}, 1000);

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
