CREATE EXTENSION "uuid-ossp";

CREATE TABLE inventories (
    id uuid PRIMARY KEY,
    account uuid not null,
    doc json not null
);

CREATE TABLE slice_permissions (
    id uuid PRIMARY KEY,
    doc json not null
);

CREATE TABLE ships (
    id uuid PRIMARY KEY,
    account uuid not null,
    doc json not null
);
