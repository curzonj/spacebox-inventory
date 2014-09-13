// blueprints and resources come from the tech system
module.exports = {
    "blueprint": {
        "type": "thinger",
        "build": {
            "time": 300,
            "resources": {
                "metal": 3
            }
        },
        "canManufacture": ["stuff"]
    },
    "factory": {
        "type": "structure",
        "build": {
            "time": 300,
            "resources": {
                "metal": 2
            }
        }
    },
    "ore": {
        "type": "resource",
        "refine": {
            "outputs": {
                "metal": 1,
                "rock": 2
            }
        }
    },
    "basicScaffold": {
        "type": "deployable",
        "build": {
            "time": 10,
            "resources": {
                "metal": 1
            }
        },
        "canConstruct": ["factory"],
    },
    "starterShip": {
        "type": "ship",
        "canRefine": ["ore"],
        "canManufacture": ["basicScaffold"]
    }
};
