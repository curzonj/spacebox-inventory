'use strict';

var http = require("http");
var express = require("express");
var logger = require('morgan');
var bodyParser = require('body-parser');
var uuidGen = require('node-uuid');
var Q = require('q');
var qhttp = require("q-io/http");
var C = require('spacebox-common');

var app = express();
var port = process.env.PORT || 5000;

app.use(logger('dev'));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({
    extended: false
}));

// TODO inventory will need to keep track of
// ships and any modules or customization they
// have. It'll need a seperate root hash.
var inventories = {};
var slice_permissions = {};
var ships = {};

function getBlueprints() {
    return qhttp.read(process.env.TECHDB_URL + '/blueprints').then(function(b) {
        return JSON.parse(b.toString());
    });
}

// NOTE /containers endpoints are restricted to spodb and production api
app.delete('/containers/:uuid', function(req, res) {
    C.authorize_req(req, true).then(function(auth) {
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

    Q.spread([getBlueprints(), C.authorize_req(req, true)], function(blueprints, auth) {
        var blueprint = blueprints[blueprintID];

        if (blueprint === undefined) {
            res.status(400).send("Invalid blueprint");
        } else if (inventories[uuid] !== undefined) {
            if (containerAuthorized(uuid, auth.account)) {
                updateContainer(uuid, blueprint);
                res.sendStatus(204);
            } else {
                console.log(auth.account, "not authorized to update", uuid);
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
    C.authorize_req(req).then(function(auth) {
        if (auth.privileged && req.param('all') == 'true') {
            res.send(inventories);
        } else {
            var my_inventories = {};

            for (var key in inventories) {
                var i = inventories[key];
                if (i.account == auth.account) {
                    my_inventories[key] = i;
                }
            }

            res.send(my_inventories);
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
        throw e;
    }).done();
});

app.get('/inventory/:uuid', function(req, res) {
    var uuid = req.param('uuid');

    C.authorize_req(req).then(function(auth) {
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

app.post('/ships/:uuid', function(req, res) {
    Q.spread([getBlueprints(), C.authorize_req(req, true)], function(blueprints, auth) {
        var uuid = req.param('uuid');
        var ship = ships[uuid];

        console.log(ship);
        console.log(req.body);

        if (ship === undefined) {
            return res.sendStatus(404);
        }

        delete req.body.blueprint;

        var blueprint = blueprints[ship.blueprint];
        var undock = req.body.in_space;
        var quantity, location, slice;

        if (undock !== undefined) {
            if (undock === true) {
                if (!containerAuthorized(ship.location, auth.account)) {
                    return res.sendStatus(401);
                }

                executeTransfers([{
                        ship_uuid: uuid,
                        quantity: -1, // undock
                        inventory: ship.location,
                        blueprint: blueprint,
                        slice: ship.slice
                }]);
            } else if (undock === false) {
                if (!containerAuthorized(req.body.location, auth.account)) {
                    return res.sendStatus(401);
                }

                executeTransfers([{
                        ship_uuid: uuid,
                        quantity: 1, // dock
                        inventory: req.body.location,
                        blueprint: blueprint,
                        slice: req.body.slice
                }]);
            } else {
                throw new Error("invalid in_space: %s", undock);
            }
        }

        delete req.body.location;
        delete req.body.slice;

        C.deepMerge(req.body, ship);

        res.send(ship);
    }).done();
});

// this unpacks a ship from inventory and makes it unique
app.post('/ships', function(req, res) {
    var uuid = uuidGen.v1(),
    inventoryID = req.param('inventory'),
    sliceID = req.param('slice'),
    blueprintID = req.param('blueprint'),
    inventory = inventories[inventoryID];

    Q.spread([getBlueprints(), C.authorize_req(req)], function(blueprints, auth) {
        if (!containerAuthorized(inventoryID, auth.account)) {
            return res.sendStatus(401);
        }

        var blueprint  = blueprints[blueprintID];

        if (inventory === undefined || inventory.hanger[sliceID] === undefined) {
            res.status(400).send("no such inventory");
        } else if (blueprint === undefined) {
            res.status(400).send("invalid blueprint");
        } else {
            var slice = inventory.hanger[sliceID];

            if (slice[blueprintID] === undefined || slice[blueprintID] === 0) {
                throw new Error("no ships present: " + blueprintID);
            }

            slice[blueprintID] -= 1;

            var ship = ships[uuid] = {
                uuid: uuid,
                blueprint: blueprintID,
                location: inventoryID,
                slice: sliceID,
                in_space: false
            };

            slice.unpacked.push(uuid);

            buildContainer(uuid, auth.account, blueprint);

            res.send(ship);
        }
    }).fail(function(e) {
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

// TODO support a schema validation
app.post('/inventory', function(req, res) {
    Q.spread([getBlueprints(), C.authorize_req(req)], function(blueprints, auth) {
        var dataset = req.body,
        transactions = [],
        containers = [],
        new_containers = [],
        old_containers = [];

        dataset.forEach(function(t) {
            t.blueprint = blueprints[t.blueprint];
        });

        // TODO this method of authorization doesn't allow
        // cross account trades

        dataset.forEach(function(t) {
            if (t.container_action === undefined) return;

            //This is currently unpriviliged because spodb isn't ready
            //yet. But that's ok because the balanced transactions below
            //make sure that it must already exist to be deployed.
            /*if (auth.priviliged === true) {
            // Because spodb does it when it deploys things from inventory
            throw new Error("not authorized to create containers");
            }*/

            if (t.container_action == "create") {
                new_containers.push(t.uuid);
            } else {
                old_containers.push(t.uuid);

                if (!containerAuthorized(t.uuid, auth.account)) {
                    throw new Error("not authorized to delete " + t.uuid);
                }
            }

            containers.push(t);
        });

        dataset.forEach(function(t) {
            if (t.container_action !== undefined) return;

            if (old_containers.indexOf(t.inventory) > 0) {
                throw new Error(t.inventory + " is being deleted");
            } else if (new_containers.indexOf(t.inventory) == -1 &&
                       !containerAuthorized(t.inventory, auth.account)) {
                throw new Error(auth.account + " cannot access " + t.inventory);
            }

            if (t.ship_uuid !== undefined) {
                var shipRecord = ships[t.ship_uuid];
                if (shipRecord === undefined) {
                    throw new Error("no such ship: "+t.ship_uuid);
                } else if(shipRecord.in_space === true) {
                    throw new Error("that ship is in space and cannot be moved");
                } else {
                    t.blueprint = blueprints[shipRecord.blueprint];
                }

                if (t.quantity === -1) {
                    if (shipRecord.location !== t.inventory || shipRecord.slice !== t.slice) {
                        throw new Error("the ship is not there");
                    }
                } else if (t.quantity != 1) {
                    throw new Error("quantity must be 1 or -1 for unpacked ships");
                }
            }

            if (t.blueprint === undefined || (t.blueprint.volume === undefined)) {
                throw new Error("invalid blueprint: " + t.blueprint);
            }

            transactions.push(t);
        });

        // validate that the transaction is balanced unless the user is special
        if (auth.privileged !== true) {
            var counters = {};

            var increment = function(type, q) {
                if (counters[type] === undefined) {
                    counters[type] = 0;
                }

                counters[type] += q;
            };

            containers.forEach(function(c) {
                increment(c.blueprint.uuid, (c.container_action == 'create' ? 1 : -1));
            });

            transactions.forEach(function(t) {
                increment(t.ship_uuid || t.blueprint.uuid, t.quantity);
            });

            for (var key in counters) {
                if (counters[key] !== 0) {
                    throw new Error(key + " is not balanced");
                }
            }
        }

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

        return res.sendStatus(204);
    }).fail(function(e) {
        console.log(e); // TODO include request-id
        res.status(500).send(e.toString());
    }).done();
});

// TODO if there is not enough room, the transaction will fail unbalanced
function executeTransfers(transfers) {
    transfers.forEach(function(transfer) {
        var example = {
            inventory: 'uuid',
            slice: 'uuid',
            quantity: 5,
            blueprint: {},
            ship_uuid: 'uuid' // only for unpacked ships and quantity must == -1 or 1
        };
        console.log(transfer);

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
                list.push(transfer.ship_uuid);

                ships[transfer.blueprint.uuid].location = transfer.inventory;
                ships[transfer.blueprint.uuid].slice = transfer.slice;
            } else {
                var i = list.indexOf(transfer.ship_uuid);
                var shipRecord = ships[transfer.ship_uuid];

                if (i == -1 || shipRecord.location !== transfer.inventory || shipRecord.slice !== transfer.slice) {
                    throw new Error("ship not present in hanger: " + transfer.ship_uuid);
                } else {
                    list.splice(i, 1);
                }
            }
        } else {
            if (slice[type] === undefined) {
                slice[type] = 0;
            }

            var result = slice[type] + transfer.quantity;

            if (result < 0) {
                throw new Error("Not enough cargo present: "+type);
            }

            slice[type] = result;
        }

        inventory.usage[slot] = final_volume;
    });
}

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
