# Sharding and Replication

- Each transact() gets a shard identifier to work on.
- Each row key is prefixed by the shard identifier.
- There should be only one writer process per machine, communicating with the reader library instances through shared memory.
- For each shard, we should know (in the db?) which (usually 3) servers hold this data. The first server listed is the primary.
    - The shard-placement data can be in a meta-shard that is replicated across all servers (with as usual a single primary).
- The commit process will transmit each transaction buffer to each of the other servers for that shard. (In-order per shard.)
- When half of the other servers has confirmed (thereby also acknowledging that this server is still the primary for this shard), the transaction can be scheduled for actual execution.
- Executing a transact() for a shard we're..
  - primary server for should just work, and fast!
  - only a secondary server for should work, though the commit phase (the buffer) will be delegated to the primary
  - not any type of server for should start a remote transaction on a primary/secondary (delegating all put/get/dels), though this may be slow
- TODO: raft-like handling of various failure scenarios

Fail a server:
- Remove a server from all shard-placements

Add a server:
- Create a new server-id
- Possibly find and join shards with insufficient servers

Have a server join a shard:
- Have the primary shard-placement server add us to the shard server list
- Ask the primary server for the shard to send us a snapshot of all shard data, inserting a bogus 'start here' message into the delta stream, where the new client needs to start replicating after it's done copying

