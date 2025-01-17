// Must keep until v8.0 becomes last lts
(function() {

const kDocId = 1;

let makeNewCluster = function() {
    let st = new ShardingTest({
        shards: {rs0: {nodes: 1, setParameter: {featureFlagAllMongodsAreSharded: true}}},
        other: {useAutoBootstrapProcedure: true}
    });

    assert.commandWorked(st.s.adminCommand({enableSharding: 'test'}));
    assert.commandWorked(st.s.adminCommand({shardCollection: 'test.user', key: {_id: 1}}));
    assert.commandWorked(st.s.getDB('test').user.insert({_id: kDocId, z: 1}));

    assert.commandWorked(
        st.s.adminCommand({setFeatureCompatibilityVersion: lastLTSFCV, confirm: true}));

    return st;
};

let testCRUD = function(conn) {
    let coll = conn.getDB('test').user;

    let doc = coll.findOne({_id: kDocId});
    assert.neq(null, doc);

    let res = coll.update({_id: kDocId}, {$inc: {x: 1}});
    assert.eq(1, res.nMatched, tojson(res));
};

let removeShardingMetadata = function(conn) {
    let config = conn.getDB('config');

    config.actionlog.drop();
    config.databases.drop();
    config.cache.collections.drop();
    config.cache.databases.drop();
    config.migrationCoordinators.drop();
    config.migrationRecipients.drop();
    config.shardMergeRecipients.drop();
    config.shardSplitDonors.drop();
    config.rangeDeletions.drop();
    config.rangeDeletionsForRename.drop();
    config.reshardingOperations.drop();
    config.localReshardingOperations.donor.drop();
    config.localReshardingOperations.recipient.drop();
    config.localRenameParticipants.drop();
    config.settings.drop();
    config.localReshardingOperations.recipient.progress_applier.drop();
    config.localReshardingOperations.recipient.progress_txn_cloner.drop();
    config.collection_critical_sections.drop();
    config.sharding_configsvr_coordinators.drop();
    config.shards.drop();
    config.collections.drop();
    config.csrs.indexes.drop();
    config.shard.indexes.drop();
    config.shard.collections.drop();
    config.placementHistory.drop();
    config.lockpings.drop();
    config.locks.drop();
    config.analyzeShardKeySplitPoints.drop();
    config.changelog.drop();
    config.chunks.drop();
    config.tags.drop();
    config.getCollection('version').drop();
    config.mongos.drop();

    let cachedChunkColls = conn.getDB('config').runCommand(
        {listCollections: 1, filter: {name: /cache.chunks*/}, nameOnly: true});

    assert.eq(0, cachedChunkColls.cursor.id);  // Should fit on first response
    cachedChunkColls.cursor.firstBatch.forEach((coll) => {
        conn.getDB('config').getCollection(coll.name).drop();
    });
};

let verifyConfigColl = function(conn) {
    let expectedCollections = [
        'system.sessions',
        'system.indexBuilds',
        // system.* cannot be dropped
        'system.sharding_ddl_coordinators',
        'sampledQueries',
        'tenantMigrationDonors',
        'sampledQueriesDiff',
        'image_collection',
        'external_validation_keys',
        'tenantMigrationRecipients',
        'transactions',
        'system.preimages',
        'vectorClock',
    ];

    let configColls = conn.getDB('config').runCommand({listCollections: 1, nameOnly: true});

    assert.eq(0, configColls.cursor.id);  // Should fit on first response

    let unexpectedColls = [];
    configColls.cursor.firstBatch.forEach((coll) => {
        if (!expectedCollections.includes(coll.name)) {
            unexpectedColls.push(coll.name);
        }
    });

    assert.eq([], unexpectedColls);
};

(function() {
jsTest.log('Testing downgrade to sharded cluster');

let st = makeNewCluster();

// Add a shard in order to be able to transition to dedicated config
const additionalShard = new ReplSetTest({name: "shard0", nodes: 1, nodeOptions: {shardsvr: ""}});
additionalShard.startSet();
additionalShard.initiate();

assert.commandWorked(st.s.adminCommand({addShard: additionalShard.getURL(), name: 'shard0'}));
assert.commandWorked(st.s.adminCommand(
    {moveChunk: 'test.user', find: {_id: MinKey}, to: 'shard0', _waitForDelete: true}));
assert.commandWorked(st.s.adminCommand({movePrimary: 'test', to: 'shard0'}));
assert.commandWorked(st.s.adminCommand(
    {moveChunk: "config.system.sessions", find: {_id: 0}, to: 'shard0', _waitForDelete: true}));

let res = st.s.adminCommand({transitionToDedicatedConfigServer: 1});
assert.eq("started", res.state);

res = st.s.adminCommand({transitionToDedicatedConfigServer: 1});
assert.eq("completed", res.state);

st.stop({noCleanData: true});  // keep data files
additionalShard.stopSet(null /* signal */, true /* forRestart */, {noCleanData: true});

const oldConfig = st.rs0.nodes[0];
let configConn = MongoRunner.runMongod({
    binVersion: 'last-lts',
    noCleanData: true,
    configsvr: '',
    replSet: st.rs0.name,
    dbpath: oldConfig.dbpath,
    port: oldConfig.port
});

const oldShard = additionalShard.nodes[0];
let shardConn = MongoRunner.runMongod({
    binVersion: 'last-lts',
    noCleanData: true,
    shardsvr: '',
    replSet: additionalShard.name,
    dbpath: oldShard.dbpath,
    port: oldShard.port
});

const oldMongos = st.s;
const newOpt = Object.merge({binVersion: 'last-lts'}, oldMongos.fullOptions);
let mongosConn = MongoRunner.runMongos(newOpt);

testCRUD(mongosConn);

MongoRunner.stopMongos(mongosConn);
MongoRunner.stopMongod(shardConn);
MongoRunner.stopMongod(configConn);
})();

(function() {
jsTest.log('Testing downgrade to replica set');

let st = makeNewCluster();

st.stop({noCleanData: true});  // keep data files

const oldConfig = st.rs0.nodes[0];
let configConn = MongoRunner.runMongod(
    {binVersion: 'last-lts', noCleanData: true, dbpath: oldConfig.dbpath, port: oldConfig.port});

assert.commandWorked(configConn.getDB('local').system.replset.update({}, {$unset: {configsvr: 1}}));

MongoRunner.stopMongod(configConn);

configConn = MongoRunner.runMongod({
    binVersion: 'last-lts',
    replSet: st.rs0.name,
    noCleanData: true,
    dbpath: oldConfig.dbpath,
    port: oldConfig.port
});

removeShardingMetadata(configConn);
verifyConfigColl(configConn);

testCRUD(configConn);

MongoRunner.stopMongod(configConn);
})();

(function() {
jsTest.log('Testing downgrade to standalone');

let st = makeNewCluster();

st.stop({noCleanData: true});  // keep data files

const oldConfig = st.rs0.nodes[0];
let configConn = MongoRunner.runMongod(
    {binVersion: 'last-lts', noCleanData: true, dbpath: oldConfig.dbpath, port: oldConfig.port});

assert.commandWorked(configConn.getDB('local').system.replset.update({}, {$unset: {configsvr: 1}}));

MongoRunner.stopMongod(configConn);

configConn = MongoRunner.runMongod(
    {binVersion: 'last-lts', noCleanData: true, dbpath: oldConfig.dbpath, port: oldConfig.port});

let localDB = configConn.getDB("local");
localDB.system.replset.remove({}, false /* justOne */);

removeShardingMetadata(configConn);

verifyConfigColl(configConn);
testCRUD(configConn);

MongoRunner.stopMongod(configConn);

// Can still convert to replSet after repl doc was deleted.

configConn = MongoRunner.runMongod({
    binVersion: 'last-lts',
    replSet: st.rs0.name,
    noCleanData: true,
    dbpath: oldConfig.dbpath,
    port: oldConfig.port
});

assert.commandWorked(configConn.getDB('admin').runCommand({replSetInitiate: 1}));

configConn.setSecondaryOk();
assert.soon(() => {
    let hello = configConn.getDB('admin')._helloOrLegacyHello();
    return hello.me && hello.me == hello.primary && (hello.isWritablePrimary || hello.ismaster);
});

testCRUD(configConn);
MongoRunner.stopMongod(configConn);
})();
})();
