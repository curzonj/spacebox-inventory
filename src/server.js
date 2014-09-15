'use strict';

var http = require("http");
var express = require("express");
var logger = require('morgan');
var bodyParser = require('body-parser');
var uuidGen = require('node-uuid');
var Q = require('q');
var qhttp = require("q-io/http");

var app = express();
var port = process.env.PORT || 5000;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

var inventories = {};

function getSpoDB() {
    return qhttp.read(process.env.SPODB_URL + '/spodb').then(function(b) {
        return JSON.parse(b.toString());
    });
}

function getBlueprints() {
    return qhttp.read(process.env.TECHDB_URL + '/blueprints').then(function (b){
        return JSON.parse(b.toString());
    });
}

app.get('/inventories', function(req, res) {
    res.send(inventories);
});

app.post('/inventories/:uuid/:slice', function(req, res) {
    var uuid = req.param('uuid');
    var sliceID = req.param('slice');
    var type = req.param('type');

    // We need the blueprints, but if we need the spodb too, get started
    var blueprintP = getBlueprints();
    var inventoryP = Q.fcall(function() {
        // does the uuid exist, what is it's blueprint
        // how much can the blueprint hold
        if (inventories[uuid] === undefined) {
            return Q.all([blueprintP, getSpoDB()])
            .spread(function(blueprints, spodb) {
                var spo = spodb[uuid];
                //console.log(spodb);
                console.log(blueprints);
                console.log(spo);


                if (spo === undefined ||
                    spo.values.blueprint === undefined ||
                    blueprints[spo.values.blueprint] === undefined) {

                    throw new Error("No valid object in spodb");
                } else {
                    var b = blueprints[spo.values.blueprint];

                    inventories[uuid] = {
                        capacity: {
                            cargo: b.inventory_capacity || 0,
                            hanger: b.hanger_capacity || 0,
                        },
                        usage: {
                            cargo: 0,
                            hanger: 0
                        },
                        cargo: {},
                        hanger: {}
                    };

                    return inventories[uuid];
                }
            });
        } else {
            return inventories[uuid];
        }
    });

    Q.spread([blueprintP, inventoryP], function(blueprints, inventory) {
        var slot, blueprint = blueprints[type];

        if (blueprint === undefined ||
            blueprint.volume === undefined) {
            throw new Error("invalid blueprint: "+type);
        }

        if (blueprint.type == "spaceship") {
            slot = "hanger";
        } else {
            slot = "cargo";
        }

        var quantity = req.param("quantity");
        var volume = quantity * blueprint.volume;
        if (inventory.usage[slot] + volume > inventory.capacity[slot]) {
            throw new Error("No room left");
        } else {
            inventory.usage[slot] += volume;
        }

        if (inventory[slot][sliceID] === undefined) {
            inventory[slot][sliceID] = {};
        }

        var slice = inventory[slot][sliceID];

        if (slice[type] === undefined) {
            slice[type] = 0;
        }

        slice[type] = slice[type] + parseInt(req.param("quantity"));
        res.send(inventory);
    }).fail(function(error) {
        res.status(500).send(error.message);
    });
});

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
