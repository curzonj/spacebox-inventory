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
var slice_permissions = {};

function authorize(req, restricted) {
    var auth_header = req.get('Authorization');
    if (auth_header === undefined) {
        throw new Error("not authorized");
    }

    var parts = auth_header.split(' ');

    // TODO make a way for internal apis to authorize
    // as a specific account without having to get a
    // different bearer token for each one. Perhaps
    // auth will return a certain account if the authorized
    // token has metadata appended to the end of it
    // or is fernet encoded.
    if (parts[0] != "Bearer") {
        throw new Error("not authorized");
    }

    // This will fail if it's not authorized
    return qhttp.request({
        method: "POST",
        url: process.env.AUTH_URL + '/token',
        headers: {
            "Content-Type": "application/json"
        },
        body: [JSON.stringify({
            token: parts[1],
            restricted: (restricted === true)
        })]
    }).then(function(res) {
        if (res.status != 200) {
            throw new Error("not authorized");
        } else {
            return res.body.read();
        }
    }).then(function(body) {
        return JSON.parse(body.toString());
    });
}

function getBlueprints() {
    return qhttp.read(process.env.TECHDB_URL + '/blueprints').then(function(b) {
        return JSON.parse(b.toString());
    });
}

// NOTE /containers endpoints are restricted to spodb and production api
app.delete('/containers/:uuid', function(req, res) {
    authorize(req, true).then(function(auth) {
        var uuid = req.param('uuid');

        if (inventories[uuid] === undefined) {
            res.sendStatus(404);
            return;
        }

        if (containerAuthorized(uuid, auth.account)) {
            destroyContainer(uuid);
            res.sendStatus(204);
        } else {
            res.sendStatus(401);
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

app.post('/containers/:uuid', function(req, res) {
    var uuid = req.param('uuid'),
        blueprintID = req.param('blueprint');

    Q.spread([getBlueprints(), authorize(req, true)], function(blueprints, auth) {
        var blueprint = blueprints[blueprintID];

        if (blueprint === undefined) {
            res.status(400).send("Invalid blueprint");
        } else if (inventories[uuid] !== undefined) {
            if (containerAuthorized(uuid, auth.account)) {
                updateContainer(uuid, auth.account, blueprint);
                res.sendStatus(204);
            } else {
                console.log(auth.account, "not authorized to update",uuid);
                res.sendStatus(401);
            }
        } else {
            buildContainer(uuid, auth.account, blueprint);
            res.sendStatus(204);
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

function containerAuthorized(uuid, account) {
    var i = inventories[uuid];

    return (i !== undefined && i.account == account);
}

function updateContainer(uuid, newBlueprint) {
    var i = inventories[uuid],
        b = newBlueprint;

    i.blueprint = newBlueprint.uuid;
    i.capacity.cargo = b.inventory_capacity;
    i.capacity.hanger = b.hanger_capacity;
}

function buildContainer(uuid, account, blueprint) {
    var b = blueprint;

    inventories[uuid] = {
        blueprint: b.uuid,
        account: account,
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
}

function destroyContainer(uuid) {
    if (inventories[uuid] === undefined) {
        throw new Error("No such inventory");
    }

    inventories[uuid].tombstone = true;
}

app.get('/inventory', function(req, res) {
    authorize(req).then(function(auth) {
        var my_inventories = {};

        for (var key in inventories) {
            var i = inventories[key];
            if (i.account == auth.account) {
                my_inventories[key] = i;
            }
        }

        res.send(my_inventories);
    }).fail(function(e) {
        res.status(500).send(e.toString());
        throw e;
    }).done();
});

app.get('/inventory/:uuid', function(req, res) {
    var uuid = req.param('uuid');

    authorize(req).then(function(auth) {
        if (containerAuthorized(uuid, auth.account)) {
            res.send(inventories[uuid]);
        } else {
            res.sendStatus(401);
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
        throw e;
    }).done();
});

// this unpacks a ship from inventory and makes it unique
app.post('/ships', function(req, res) {
    var uuid = uuidGen.v1(),
        inventoryID = req.param('inventory'),
        sliceID = req.param('slice'),
        blueprintID = req.param('blueprint'),
        inventory = inventories[inventoryID];

    authorize(req).then(function(auth) {
        if (!containerAuthorized(inventoryID, auth.account)) {
            return res.sendStatus(401);
        }

        if (inventory === undefined || inventory.hanger[sliceID] === undefined) {
            res.status(400).send("no such inventory");
        } else {
            var slice = inventory.hanger[sliceID];

            if (slice[blueprintID] === undefined || slice[blueprintID] === 0) {
                throw new Error("no ships present: " + blueprintID);
            }

            slice[blueprintID] -= 1;

            slice.unpacked.push({
                uuid: uuid,
                blueprint: blueprintID
            });

            buildContainer(uuid, blueprintID);

            res.sendStatus(201);
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

// TODO support a schema validation
app.post('/inventory', function(req, res) {
    var transactions = [],
        containers = [];

    Q.spread([getBlueprints(), authorize(req)], function(blueprints, auth) {
        req.body.forEach(function(t) {
            if (t.ship_uuid !== undefined) {
                // TODO lookup the blueprint we have stored

                if (t.quantity != -1 && t.quantity != 1) {
                    throw new Error("quantity must be 1 or -1 for unpacked ships");
                }
            }

            var blueprint = blueprints[t.blueprint];
            if (blueprint === undefined || blueprint.volume === undefined) {
                throw new Error("invalid blueprint: " + t.blueprint);
            } else {
                t.blueprint = blueprint;
            }

            // TODO each one of these has to be authorized
            if (t.container_action !== undefined) {
                if (t.container_action != "create" &&
                    !containerAuthorized(t.uuid, auth.account)) {
                    return res.sendStatus(401);
                }

                containers.push(t);
            } else {
                if (!containerAuthorized(t.inventory, auth.account)) {
                    console.log(auth.account, "cannot access", t.inventory);
                    return res.sendStatus(401);
                }

                transactions.push(t);
            }
        });

        // validate that the transaction is balanced unless the user is special

        // TODO this should all be in postgres and a database transaction
        containers.forEach(function(c) {
            if (c.container_action == "create") {
                buildContainer(c.uuid, auth.account, c.blueprint);
            } else { // destroy ?
                if (inventories[c.uuid] === undefined) {
                    throw new Error("no such inventory");
                }

                destroyContainer(c.uuid);
            }
        });

        executeTransfers(transactions);

        res.sendStatus(204);
    }).fail(function(e) {
        res.status(500).send(e.toString());
    }).done();
});

function executeTransfers(transfers) {
    transfers.forEach(function(transfer) {
        var example = {
            inventory: 'uuid',
            slice: 'uuid',
            quantity: 5,
            blueprint: {},
            ship_uuid: 'uuid' // only for unpacked ships and quantity must == -1 or 1
        };

        var slot;
        var inventory = inventories[transfer.inventory];
        var quantity = transfer.quantity;
        var sliceID = transfer.slice;
        var type = transfer.blueprint.uuid;

        if (inventory === undefined) {
            throw new Error("no such inventory: " + transfer.inventory);
        }

        if (transfer.blueprint.type == "spaceship") {
            slot = "hanger";

            if (inventory[slot][sliceID] === undefined) {
                inventory[slot][sliceID] = {
                    unpacked: []
                };
            }
        } else {
            slot = "cargo";

            if (inventory[slot][sliceID] === undefined) {
                inventory[slot][sliceID] = {};
            }
        }

        var slice = inventory[slot][sliceID];
        var volume = quantity * transfer.blueprint.volume;
        var final_volume = inventory.usage[slot] + volume;

        if (final_volume > inventory.capacity[slot]) {
            throw new Error("No room left");
        }

        if (transfer.ship_uuid !== undefined) {
            var list = slice.unpacked;
            if (quantity > 0) {
                slice.push({
                    uuid: transfer.ship_uuid,
                    blueprint: transfer.blueprint.uuid
                });
            } else {
                var i = slice.indexOf(transfer.ship_uuid);

                if (i == -1) {
                    throw new Error("ship not present in hanger: " + transfer.ship_uuid);
                } else {
                    slice.splice(i, 1);
                }
            }
        } else {
            if (slice[type] === undefined) {
                slice[type] = 0;
            }

            var result = slice[type] + transfer.quantity;

            if (result < 0) {
                throw new Error("Not enough cargo present");
            }

            slice[type] = result;
        }

        inventory.usage[slot] = final_volume;
    });
}

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
