'use strict';

var http = require("http");
var express = require("express");
var logger = require('morgan');
var bodyParser = require('body-parser');
var uuidGen = require('node-uuid');
var Q = require('q');
var qhttp = require("q-io/http");
var C = require('spacebox-common');

var pgpLib = require('pg-promise');
var pgp = pgpLib(/*options*/);
var database_url = process.env.DATABASE_URL || process.env.INVENTORY_DATABASE_URL;
var db = pgp(database_url);

var app = express();
var port = process.env.PORT || 5000;

Q.longStackSupport = true;

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

var dao = {
    all: function(account) {
        if (account === undefined) {
            return db.query("select * from inventories");
        } else {
            return db.query("select * from inventories where account=$1", [ account ]);
        }
    },
    get: function(uuid) {
        return db.
            query("select * from inventories where id=$1", [ uuid ]).
            then(function(data) {
                return data[0];
            });
    },
    update: function(uuid, doc) {
        return db.
            query("update inventories set doc = $2 where id =$1", [ uuid, doc ]);
    },
    insert: function(uuid, doc) {
        return db.
            query("insert into inventories (id, account, doc) values ($1, $2, $3)",
                  [ uuid, doc.account, doc ]);
    },
    destroy: function (uuid) {
        // TODO this should also require that the container is empty
        return db.query("delete from inventories where id = $1", [ uuid ]);
    }
};

// NOTE /containers endpoints are restricted to spodb and production api
app.delete('/containers/:uuid', function(req, res) {
    C.authorize_req(req, true).then(function(auth) {
        var uuid = req.param('uuid');

        return dao.get(uuid).then(function(container) {
                if (container !== undefined) {
                    if (containerAuthorized(container, auth.account)) {
                        return dao.destroy(uuid).then(function() {
                            res.sendStatus(204);
                        });
                    } else {
                        res.sendStatus(401);
                    }
                } else {
                    res.sendStatus(404);
                
                }
            });
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

app.post('/containers/:uuid', function(req, res) {
    var uuid = req.param('uuid'),
    blueprintID = req.param('blueprint');

    Q.spread([C.getBlueprints(), C.authorize_req(req, true), dao.get(uuid)], function(blueprints, auth, container) {
        var blueprint = blueprints[blueprintID];

        if (blueprint === undefined) {
            res.status(400).send("Invalid blueprint");
        } else if (container !== undefined) {
            if (containerAuthorized(container, auth.account)) {
                updateContainer(container, blueprint);
                res.sendStatus(204);
            } else {
                console.log(auth.account, "not authorized to update", uuid);
                res.sendStatus(401);
            }
        } else {
            return buildContainer(uuid, auth.account, blueprint).then(function() {
                res.sendStatus(204);
            });
        }
    }).fail(function(e) {
        console.log(e);
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

function containerAuthorized(container, account) {
    return (container !== undefined && container.account == account);
}

function updateContainer(container, newBlueprint) {
    var i = container,
        b = newBlueprint;

    i.blueprint = newBlueprint.uuid;
    i.capacity.cargo = b.inventory_capacity;
    i.capacity.hanger = b.hanger_capacity;
}

function buildContainer(uuid, account, blueprint) {
    var b = blueprint;

    return dao.insert(uuid, {
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
    });
}

app.get('/inventory', function(req, res) {
    C.authorize_req(req).then(function(auth) {
        if (auth.privileged && req.param('all') == 'true') {
            return dao.all().then(function(data) {
                res.send(data);
            });
        } else {
            return dao.all(auth.account).then(function(data) {
                res.send(data);
            });
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
        throw e;
    }).done();
});

app.get('/inventory/:uuid', function(req, res) {
    var uuid = req.param('uuid');

    Q.spread([C.authorize_req(req), dao.get(uuid)], function(auth, container) {
        if (containerAuthorized(container, auth.account)) {
            res.send(container.doc);
        } else {
            res.sendStatus(401);
        }
    }).fail(function(e) {
        res.status(500).send(e.toString());
        throw e;
    }).done();
});

app.post('/ships/:uuid', function(req, res) {
    Q.spread([C.getBlueprints(), C.authorize_req(req, true)], function(blueprints, auth) {
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
        blueprintID = req.param('blueprint');

    Q.spread([C.getBlueprints(), C.authorize_req(req), dao.get(inventoryID)], function(blueprints, auth, inventory) {
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

            return buildContainer(uuid, auth.account, blueprint).then(function() {
                res.send(ship);
            });
        }
    }).fail(function(e) {
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

// TODO support a schema validation
app.post('/inventory', function(req, res) {
    Q.spread([C.getBlueprints(), C.authorize_req(req)], function(blueprints, auth) {
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

        console.log(dataset, new_containers, old_containers, containers);

        return Q.fcall(function() {
            return Q.all(dataset.map(function(t) {
                if (t.container_action !== undefined) return;

                if (old_containers.indexOf(t.inventory) > 0) {
                    throw new Error(t.inventory + " is being deleted");
                } else if (new_containers.indexOf(t.inventory) == -1) {
                    return dao.get(t.inventory).then(function(container) {
                        if (!containerAuthorized(container, auth.account)) {
                            throw new Error(auth.account + " cannot access " + t.inventory);
                        }
                    });
                }
            }));
        }).then(function() {
            dataset.forEach(function(t) {
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

                if (t.container_action === undefined) {
                    transactions.push(t);
                }
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
        }).then(function() {
            // TODO this should all be in a database transaction
            return Q.all(containers.map(function(c) {
                if (c.container_action == "create") {
                    return buildContainer(c.uuid, auth.account, c.blueprint);
                } else { // destroy ?
                    return dao.destroy(c.uuid);
                }
            }));
        }).then(function() {
            console.log('executing', transactions);
            return executeTransfers(transactions);
        }).then(function() {
            res.sendStatus(204);
        });
    }).fail(function(e) {
        console.log(e); // TODO include request-id
        console.log(e.stack);
        res.status(500).send(e.toString());
    }).done();
});

// TODO if there is not enough room, the transaction will fail unbalanced
function executeTransfers(transfers) {
    return Q.all(transfers.map(function(transfer) {
        var example = {
            inventory: 'uuid',
            slice: 'uuid',
            quantity: 5,
            blueprint: {},
            ship_uuid: 'uuid' // only for unpacked ships and quantity must == -1 or 1
        };
        var example_container = {
            uuid: 'uuid',
            container_action: 'create|destroy',
            blueprint: 'uuid'
        };
        console.log(transfer);

        return dao.get(transfer.inventory).then(function(data) {
            var slot;
            var inventory = data.doc,
                quantity = transfer.quantity,
                sliceID = transfer.slice;

            var type = transfer.blueprint.uuid;

            console.log('inventory', inventory);

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

            return dao.update(transfer.inventory, inventory);
        });
    }));
}

var server = http.createServer(app);
server.listen(port);
console.log("server ready");
