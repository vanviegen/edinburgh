# Edinburgh
**TypeScript objects that live in the database.**

Edinburgh blurs the line between in-memory objects and database records. Define a model class, and its instances *are* the database rows. They are read directly from a memory-mapped [LMDB](http://www.lmdb.tech/doc/) store on first access, and mutations are written back in an ACID transaction on commit. There is no SQL layer, no query builder, no network round-trip, and no result-set marshalling. A primary-key lookup completes in about 1 µs.

This makes problems like n+1 queries irrelevant: traversing `post.author.department.manager` is just a chain of microsecond memory-mapped reads, not a cascade of network calls.

Built on [OLMDB](https://github.com/vanviegen/olmdb) (an optimistic-locking wrapper around LMDB).

- **Objects are records**: model fields are backed by memory-mapped storage; no serialization boundary between your code and the database
- **Sub-microsecond reads**: embedded B+ tree in the same process, no network hop, no query parsing
- **Type-safe at every layer**: TypeScript inference at compile time, runtime validation at write time
- **First-class relationships**: `E.link(OtherModel)` fields load lazily and transparently on access
- **Indexes**: primary, unique, and secondary indexes with efficient range queries
- **ACID transactions**: optimistic locking with automatic retry on conflict (up to 6 attempts)
- **Zero-downtime schema evolution**: old rows are lazily migrated on read; no batch DDL required

## Quick Demo
```typescript
import * as E from "edinburgh";

// Initialize the database (optional, defaults to ".edinburgh")
E.init("./my-database");

const User = E.defineModel("User", class {
    id = E.field(E.identifier);
    name = E.field(E.string);
    age = E.field(E.number);
    email = E.field(E.opt(E.string));
    // Optional link to another instance of this model (needs a function as `User` is not defined yet at this point)
    supervisor = E.field(E.opt(E.link(() => User)));
    // A field with a more elaborate type. In TypeScript: `User | User[] | "unknown" | "whatever"`, defaulting to "unknown".
    something = E.field(
        E.or(
            E.link(() => User),
            E.array(E.link(() => User)),
            E.literal("unknown"),
            E.literal("whatever")
        ),
        { default: "unknown" }
    );
}, {
    pk: "id",
    unique: {
        email: "email",
    },
});

await E.transact(() => {
    // Unique 'id' values are auto-generated if not provided
    const boss = new User({ name: "Big Boss", age: 50 });
    new User({
        name: "John Doe",
        age: 41,
        email: "john@example.com",
        supervisor: boss, // Link to another model instance
    });
    // Newly instantiated models are automatically saved to the database on transaction commit
});

await E.transact(() => {
    // Query by unique index
  const john = User.getBy("email", "john@example.com")!;

    // The transaction will retry if there's a conflict, such as another transaction
    // modifying the same user (from another async function or another process)
    john.age++;

    // The supervisor object is lazy loaded on first access
    console.log(`${john.supervisor!.name} is ${john.name}'s supervisor`);
});    
```

## Tutorial


### Defining Models

A model is defined using the `E.defineModel()` function by passing it..
- a consistent table name,
- an (anonymous) class containing `E.field` database properties and optionally regular properties/methods, and
- optional key/index configuration.

```typescript
import * as E from "edinburgh";

const User = E.defineModel("User", class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
  age = E.field(E.number);
}, {
  pk: "id",
  unique: {
    email: "email",
  },
});
// Add this if you want to use User as a type annotation (e.g. `let u: User`).
// Not needed just to call User.get(), User.find(), new User(), etc.
type User = InstanceType<typeof User>;
```

Instance fields are declared with `E.field(type, options?)`. Available types:

| Type | TypeScript type | Notes |
|------|----------------|-------|
| `E.string` | `string` | |
| `E.orderedString` | `string` | Lexicographic sort in indexes; no null bytes |
| `E.number` | `number` | |
| `E.boolean` | `boolean` | |
| `E.dateTime` | `Date` | Defaults to `new Date()` |
| `E.identifier` | `string` | Auto-generated 8-char unique ID |
| `E.opt(T)` | `T \| undefined` | Makes any type optional |
| `E.or(A, B, ...)` | `A \| B \| ...` | Union type; args can be types or literal values |
| `E.literal(v)` | literal type | Constant value; defaults to that value |
| `E.array(T)` | `T[]` | Optional `{min, max}` constraints |
| `E.set(T)` | `Set<T>` | Optional `{min, max}` constraints |
| `E.record(T)` | `Record<string \| number, T>` | Key-value object with string/number keys |
| `E.link(Model)` | `Model` | Foreign key, lazy-loaded on access |

#### Defaults

```typescript
const Post = E.defineModel("Post", class {
  id = E.field(E.identifier); // auto-generated
  title = E.field(E.string);
  status = E.field(E.or("draft", "published"), {default: "draft"});
  tags = E.field(E.array(E.string), {default: () => []}); // use function for mutable defaults
  createdAt = E.field(E.dateTime); // dateTime defaults to new Date()
}, { pk: "id" });
```

### Transactions

All database operations must run inside `E.transact()`:

```typescript
// Initialize (optional — defaults to ".edinburgh" directory)
E.init("./my-database");

// Create
await E.transact(() => {
  // User.id is auto-generated
  new User({name: "Alice", email: "alice@example.com", age: 30});
});

// Read + Update
await E.transact(() => {
  const user = User.getBy("email", "alice@example.com");
  if (user) user.age++;
});

// Return values from transactions
const name = await E.transact(() => {
  const user = User.getBy("email", "alice@example.com");
  return user?.name;
});
```

Transactions auto-retry on conflict (up to 6 times by default). Keep transaction functions idempotent.

### Indexes

Edinburgh supports three index types:

```typescript
const Product = E.defineModel("Product", class {
  sku = E.field(E.string);
  name = E.field(E.string);
  category = E.field(E.string);
  price = E.field(E.number);
}, {
  pk: "sku",
  unique: { name: "name" },
  index: { category: "category" },
});
```

If no `pk` is provided, Edinburgh auto-creates one on an `id` field, adding it as an `E.identifier` field if needed.

#### Lookups

```typescript
await E.transact(() => {
  // Primary key lookup
  const p1 = Product.get("SKU-001");

  // Unique index lookup
  const p2 = Product.getBy("name", "Widget");

  // All return undefined if not found
});
```

If a primary key or named index includes a `link(...)` field, lookup helpers either accept the linked row's instance object or its primary key. For linked models with composite primary keys, pass the full tuple in that slot:

```typescript
await E.transact(() => {
  // So instead of..
  const post1 = Post.getBy("author", Author.get(user.id), "Hello World");
  // We can do..
  const post2 = Post.getBy("author", user.id, "Hello World");
  // Or..
  const post3 = Post.getBy("author", [user.id], "Hello World");

  // For an index that includes a link with a composite primary key..
  const page = Comment.getBy("target", ["docs", "intro"], "overview");
});
```

#### Range Queries

Primary-key queries use `.find()`. Named unique and secondary indexes use `.findBy(name, ...)`:

```typescript
await E.transact(() => {
  // Exact match
  for (const p of Product.findBy("category", {is: "electronics"})) {
    console.log(p.name);
  }

  // Range (inclusive)
  for (const p of Product.find({from: "A", to: "M"})) {
    console.log(p.sku);
  }

  // Exclusive bounds
  for (const p of Product.find({after: "A", before: "M"})) { ... }

  // Open-ended
  for (const p of Product.find({from: "M"})) { ... }

  // Reverse
  for (const p of Product.find({reverse: true})) { ... }

  // Count and fetch helpers
  const count = Product.findBy("category", {is: "electronics"}).count();
  const first = Product.findBy("category", {is: "electronics"}).fetch(); // first match or undefined
});
```

#### Composite Primary Keys

```typescript
const Event = E.defineModel("Event", class {
  year = E.field(E.number);
  month = E.field(E.number);
  id = E.field(E.identifier);
  title = E.field(E.string);
}, {
  pk: ["year", "month", "id"] as const,
});

await E.transact(() => {
  // Prefix matching — find all events in 2025
  for (const e of Event.find({is: [2025]})) { ... }

  // Find events in March 2025
  for (const e of Event.find({is: [2025, 3]})) { ... }
});
```

#### Non-Persistent Properties

You can freely add regular methods, getters, and other non-persistent properties to model classes. These work normally in JavaScript but are **not stored in the database** and **not synchronized** across transactions or processes.

```typescript
const User = E.defineModel("User", class {
  firstName = E.field(E.string);
  lastName = E.field(E.string);

  // Non-persisted property
  cachedFullName?: string;

  get fullName(): string {
    this.cachedFullName ??= `${this.firstName} ${this.lastName}`;
    return this.cachedFullName;
  }

  greet(): string {
    return `Hello, ${this.fullName}!`;
  }
});
```

#### Computed Indexes

Instead of naming fields, you can pass a function as an index specification. The function receives a model instance and returns an **array** of index key values. Each element creates a separate index entry, enabling multi-value indexes. Return `[]` to skip indexing for that instance (partial index).

```typescript
const Article = E.defineModel("Article", class {
  id = E.field(E.identifier);
  firstName = E.field(E.string);
  lastName = E.field(E.string);
  title = E.field(E.string);
  email = E.field(E.opt(E.string));
}, {
  pk: "id",
  unique: {
    fullName: (a: any) => [`${a.firstName} ${a.lastName}`], // computed covering unique index
  },
  index: {
    domain: (a: any) => a.email ? [a.email.split("@")[1]] : [], // computed partial index
    word: (a: any) => a.title.toLowerCase().split(" "), // computed multi-index
  },
});

await E.transact(() => {
  new Article({ firstName: "Jane", lastName: "Doe", title: "Hello World", email: "jane@acme.com" });

  // Lookup via computed unique index
  const jane = Article.getBy("fullName", "Jane Doe");

  // Multi-value: each word in the title is indexed separately
  for (const a of Article.findBy("word", {is: "hello"})) { ... }

  // Partial index: articles without email are skipped
  for (const a of Article.findBy("domain", {is: "acme.com"})) { ... }
});
```

### Relationships

Use `E.link(Model)` for foreign keys. Use a thunk (a function that just returns a value) for forward references when needed:

```typescript
const Author = E.defineModel("Author", class {
  id = E.field(E.identifier);
  name = E.field(E.string);
}, { pk: "id" });

const Book = E.defineModel("Book", class {
  id = E.field(E.identifier);
  title = E.field(E.string);
  author = E.field(E.link(Author));
}, { pk: "id" });

await E.transact(() => {
  const author = new Author({name: "Tolkien"});
  const book = new Book({title: "The Hobbit", author});

  // Later: linked models are lazy-loaded on property access
  const b = Book.get(book.id)!;
  console.log(b.author.id);    // no need to load yet..
  console.log(b.author.name);  // loads Author automatically (~1µs)
});
```

### Deleting

```typescript
await E.transact(() => {
  const user = User.get(someId);
  if (user) user.delete();
});
```

### Model Utilities

```typescript
await E.transact(() => {
  const user = new User({name: "Bob", email: "bob@example.com", age: 25});

  user.validate();     // returns Error[]
  user.isValid();      // returns boolean
  user.getState();     // "created" | "loaded" | "lazy" | "deleted"
  user.getPrimaryKey(); // Uint8Array
  user.preventPersist(); // exclude from commit
});

// find() iterates all instances (or use range options)
await E.transact(() => {
  for (const user of User.find()) { ... }
  for (const user of User.find({reverse: true})) { ... }

  // {fetch: 'first'} returns a single instance or undefined
  const first = User.find({fetch: 'first'});

  // {fetch: 'single'} returns a single instance, or throws if there are none or more than one
  const only = User.find({fetch: 'single'});
});

// replaceInto: upsert by primary key
await E.transact(() => {
  User.replaceInto({id: existingId, name: "Updated Name", email: "new@example.com", age: 30});
});
```

### Batch Processing

For large datasets, `batchProcess` auto-commits in batches:

```typescript
await Product.batchProcess({ limitRows: 1000 }, (product) => {
  product.category = "archived";
});
// Commits every ~1 second or 4096 rows (configurable via limitSeconds, limitRows)
```

### Lazy Schema Migrations

When you change a model's schema, Edinburgh lazily migrates old records on access. You can provide a `static migrate(record)` function to transform old rows:

```typescript
const UserV2 = E.defineModel("User", class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  role = E.field(E.string);  // newly added field

  static migrate(record: Record<string, any>) {
    record.role ??= record.name.indexOf("admin") >= 0 ? "admin" : "user"; // set role based on name for old records
  }
})
```

Edinburgh will lazily (re)run the `migrate` function on an instance whenever its implementation (the literal function code) has changed. For robustness, make sure that your `migrate` function...
- Is idempotent (meaning it can be safely run multiple times on the same row without changing the result after the first run), and
- Should perform *all* transformation steps starting from the oldest version that could possibly still be in the database. (See the next section.)

While lazy migration is convenient and often sufficient, in some cases you need migrations to happen immediately...

### Forced Schema Migrations

The `migrate-edinburgh` CLI tool will scan the entire database, pro-actively performing the following migrations:
- **Populate secondary indexes**: If you added or changed secondary indexes, it will build them. Until you do, the indexes will be empty (or only contain instances that have been saved since the index was created).
- **Migrate primary indexes**: In case you changed the primary key fields or field types (not recommended!) of a model, it will build the new primary index, as well as all secondary indexes (to point at the new primary keys). Until you do, all of your old data will appear to be missing! Note that this may fail on duplicates.
- **Remove orphaned indexes**: If you removed or changed an index, the stale data will be deleted from the database.
- **Rewrite primary data**: These are the types of migrations that would normally be done lazily on instance access. As there's usually not much benefit to doing this forcibly, and it can be very time-consuming (and generates a lot of I/O), this is *not* done by default. It may however be useful if you want to clean up the contents of your `migrate()` function, if you have control over all application deployments. Use the `--rewrite-data` flag to enable this.

```bash
npx migrate-edinburgh ./src/models.ts
```

Run `npx migrate-edinburgh` without arguments to see all options. You can also call `runMigration()` programmatically:

```typescript
import { runMigration } from "edinburgh";

const result = await runMigration({ tables: ["User"] });
console.log(result.secondaries);  // { User: 1500 }
```

### preCommit Hook

Compute derived fields before data is written:

```typescript
const Article = E.defineModel("Article", class {
  id = E.field(E.identifier);
  title = E.field(E.string);
  slug = E.field(E.string);

  preCommit() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }
});
```

### Change Tracking

Monitor commits with `setOnSaveCallback`:

```typescript
E.setOnSaveCallback((commitId, items) => {
  for (const [instance, change] of items) {
    if (change === "created") { /* new record */ }
    else if (change === "deleted") { /* removed */ }
    else { /* change is an object with old values of modified fields */ }
  }
});
```

### Logging

Enable debug logging by setting the `EDINBURGH_LOG_LEVEL` environment variable (0–3). Higher numbers produce more verbose logs.

- 0: no logging (default)
- 1: model-level logs
- 2: + update logs
- 3: + read logs

### AI Integration

If you use Claude Code, GitHub Copilot or another AI agent that supports Skills, Edinburgh includes a `skill/` directory in its npm package that provides specialized knowledge to the AI about how to use the library effectively.

Symlink the skill into your project's `.claude/skills` directory:

```bash
mkdir -p .claude/skills
ln -s ../../node_modules/edinburgh/skill .claude/skills/edinburgh
```

## API Reference

The following is auto-generated from `src/edinburgh.ts`:

### currentTxn · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L66)

Returns the current transaction from AsyncLocalStorage.
Throws if called outside a transact() callback.

**Signature:** `() => Transaction`

### init · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L85)

Initialize the database with the specified directory path.
This function may be called multiple times with the same parameters. If it is not called before the first transact(),
the database will be automatically initialized with the default directory.

**Signature:** `(dbDir: string) => void`

**Parameters:**

- `dbDir: string`

**Examples:**

```typescript
init("./my-database");
```

### transact · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L136)

Executes a function within a database transaction context.

Loading models (also through links in other models) and changing models can only be done from
within a transaction.

Transactions have a consistent view of the database, and changes made within a transaction are
isolated from other transactions until they are committed. In case a commit clashes with changes
made by another transaction, the transaction function will automatically be re-executed up to 6
times.

**Signature:** `<T>(fn: () => T) => Promise<T>`

**Type Parameters:**

- `T` - The return type of the transaction function.

**Parameters:**

- `fn: () => T` - The function to execute within the transaction context. Receives a Transaction instance.

**Returns:** A promise that resolves with the function's return value.

**Throws:**

- With code "RACING_TRANSACTION" if the transaction fails after retries due to conflicts.
- With code "TXN_LIMIT" if maximum number of transactions is reached.
- With code "LMDB-{code}" for LMDB-specific errors.

**Examples:**

```typescript
const paid = await E.transact(() => {
  const user = User.get("john_doe");
  if (user.credits > 0) {
    user.credits--;
    return true;
  }
  return false;
});
```
```typescript
// Transaction with automatic retry on conflicts
await E.transact(() => {
  const counter = Counter.get("global") || new Counter({id: "global", value: 0});
  counter.value++;
});
```

### setMaxRetryCount · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L232)

Set the maximum number of retries for a transaction in case of conflicts.
The default value is 6. Setting it to 0 will disable retries and cause transactions to fail immediately on conflict.

**Signature:** `(count: number) => void`

**Parameters:**

- `count: number` - The maximum number of retries for a transaction.

### setOnSaveCallback · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L249)

Set a callback function to be called after a model is saved and committed.

**Signature:** `(callback: (commitId: number, items: Map<ModelBase, Change>) => void) => void`

**Parameters:**

- `callback: ((commitId: number, items: Map<Model<unknown>, Change>) => void) | undefined` - The callback function to set. It gets called after each successful
`transact()` commit that has changes, with the following arguments:
- A sequential number. Higher numbers have been committed after lower numbers.
- A map of model instances to their changes. The change can be "created", "deleted", or an object containing the old values.

The callback is called within a new transaction context, allowing lazy-loads to happen. However, any
changes made to Edinburgh models will not be saved.

### Model · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Type:** `typeof ModelBase`

### ModelClass · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Runtime base constructor for model classes returned by `defineModel()`.

Prefer the `ModelClass` type alias for annotations and the result of
`defineModel()` for concrete model classes.

**Type:** `typeof ModelClassRuntime`

### AnyModelClass · [type](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L132)

A model constructor with its generic information erased.

Useful when accepting or storing arbitrary registered model classes.

**Type:** `ModelClass<object, any, any, readonly any[], any, any>`

### ModelBase · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Base class for all database models in the Edinburgh ORM.

Models represent database entities with typed fields, automatic serialization,
change tracking, and relationship management. Model classes are created using
`E.defineModel()`.

### Schema Evolution

Edinburgh tracks the schema version of each model automatically. When you add, remove, or
change the types of fields, or add/remove indexes, Edinburgh detects the new schema version.

**Lazy migration:** Changes to non-key field values are migrated lazily, when a row with an
old schema version is read from disk, it is deserialized using the old schema and optionally
transformed by the static `migrate()` function. This happens transparently on every read
and requires no downtime or batch processing.

**Batch migration (via `npx migrate-edinburgh` or `runMigration()`):** Certain schema changes
require an explicit migration run:
- Adding or removing secondary/unique indexes
- Changing the fields or types of an existing index
- A `migrate()` function that changes values used in secondary index fields

The batch migration tool populates new indexes, deletes orphaned ones, and updates index
entries whose values were changed by `migrate()`. It does *not* rewrite primary data rows
(lazy migration handles that).

### Lifecycle Hooks

- **`static migrate(record)`**: Called when deserializing rows written with an older schema
  version. Receives a plain record object; mutate it in-place to match the current schema.

- **`preCommit()`**: Called on each modified instance right before the transaction commits.
  Useful for computing derived fields, enforcing cross-field invariants, or creating related
  instances.

**Examples:**

```typescript
const User = E.defineModel("User", class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
}, {
  pk: "id",
  unique: { email: "email" },
});
// Optional: declare a companion type so `let u: User` works.
// Not needed if you only use `new User()`, `User.find()`, etc.
type User = InstanceType<typeof User>;
```

#### ModelBase.migrate · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Optional migration function called when deserializing rows written with an older schema version.
Receives a plain record with all fields and should mutate it in-place to match the current schema.
It runs during lazy loading and during `runMigration()`. Changing this method creates a new schema version.
If it updates values used by secondary or unique indexes, those index entries are refreshed only by `runMigration()`.

**Signature:** `(record: Record<string, any>) => void`

**Parameters:**

- `record: Record<string, any>` - A plain object containing the row's field values from the older schema version.

**Examples:**

```typescript
const User = E.defineModel("User", class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  role = E.field(E.string);

  static migrate(record: Record<string, any>) {
    record.role ??= "user";
  }
}, { pk: "id" });
```

#### modelBase.preCommit · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Optional hook called on each modified instance right before the transaction commits.
Runs before data is written to disk, so changes made here are included in the commit.

Common use cases:
- Computing derived or denormalized fields
- Enforcing cross-field validation rules
- Creating or updating related model instances (newly created instances will also
  have their `preCommit()` called)

**Signature:** `() => void`

**Examples:**

```typescript
const Post = E.defineModel("Post", class {
  id = E.field(E.identifier);
  title = E.field(E.string);
  slug = E.field(E.string);

  preCommit() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }
}, { pk: "id" });
```

#### modelBase.getPrimaryKey · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => Uint8Array<ArrayBufferLike>`

**Returns:** The primary key for this instance.

#### modelBase.getPrimaryKeyHash · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => number`

**Returns:** A 53-bit positive integer non-cryptographic hash of the primary key, or undefined if not yet saved.

#### modelBase.isLazyField · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(field: keyof this) => boolean`

**Parameters:**

- `field: keyof this`

#### modelBase.preventPersist · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Prevent this instance from being persisted to the database.

**Signature:** `() => this`

**Returns:** This model instance for chaining.

**Examples:**

```typescript
const user = User.get("user123");
user.name = "New Name";
user.preventPersist(); // Changes won't be saved
```

#### modelBase.delete · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Delete this model instance from the database.

Removes the instance and all its index entries from the database and prevents further persistence.

**Signature:** `() => void`

**Examples:**

```typescript
const user = User.get("user123");
user.delete(); // Removes from database
```

#### modelBase.validate · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Validate all fields in this model instance.

**Signature:** `(raise?: boolean) => Error[]`

**Parameters:**

- `raise: boolean` (optional) - If true, throw on first validation error.

**Returns:** Array of validation errors (empty if valid).

**Examples:**

```typescript
const user = new User();
const errors = user.validate();
if (errors.length > 0) {
  console.log("Validation failed:", errors);
}
```

#### modelBase.isValid · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Check if this model instance is valid.

**Signature:** `() => boolean`

**Returns:** true if all validations pass.

**Examples:**

```typescript
const user = new User({name: "John"});
if (!user.isValid()) shoutAtTheUser();
```

#### modelBase.getState · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => "created" | "deleted" | "loaded" | "lazy"`

#### modelBase.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => string`

#### modelBase.[Symbol.for('nodejs.util.inspect.custom')] · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => string`

### defineModel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Register a model class with the Edinburgh ORM system.

Converts a plain class into a fully-featured model with database persistence,
typed fields, primary key access, and optional secondary and unique indexes.

**Signature:** `<T extends new () => any, const PK extends (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[], const UNIQUE extends Record<string, IndexSpec<T>>, const INDEX extends Record<string, IndexSpec<T>>>(tableName: string, cls: T, opts?: { ...; }) => ModelClass<...>`

**Type Parameters:**

- `T extends new () => any`
- `PK extends (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[]`
- `UNIQUE extends Record<string, IndexSpec<T>>`
- `INDEX extends Record<string, IndexSpec<T>>`

**Parameters:**

- `tableName: string` - The database table name for this model.
- `cls: T` - A plain class whose properties use E.field().
- `opts?: { pk?: PK, unique?: UNIQUE, index?: INDEX, override?: boolean }` - Registration options.

**Returns:** The enhanced model constructor.

### deleteEverything · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Delete every key/value entry in the database and reinitialize all registered models.

This clears rows, index metadata, and schema-version records. It is mainly useful
for tests, local resets, or tooling that needs a completely empty database.

**Signature:** `() => Promise<void>`

### field · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L77)

Create a field definition for a model property.

This function uses TypeScript magic to return the field configuration object
while appearing to return the actual field value type to the type system.
This allows for both runtime introspection and compile-time type safety.

**Signature:** `<TYPE extends TypeWrapper<any>>(type: TYPE, options?: Partial<FieldConfig<FieldValue<TYPE>>>) => FieldValue<TYPE>`

**Type Parameters:**

- `TYPE extends TypeWrapper<any>` - The field type.

**Parameters:**

- `type: TYPE` - The type wrapper for this field.
- `options: Partial<FieldConfig<FieldValue<TYPE>>>` (optional) - Additional field configuration options.

**Returns:** The field value (typed as T, but actually returns FieldConfig<T>).

**Examples:**

```typescript
const User = E.defineModel("User", class {
  name = E.field(E.string, {description: "User's full name"});
  age = E.field(E.opt(E.number), {description: "User's age", default: 25});
});
```

### string · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the string type.

**Value:** `TypeWrapper<string>`

### orderedString · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the ordered string type, which is just like a string
except that it sorts lexicographically in the database (instead of by incrementing
length first), making it suitable for index fields that want lexicographic range
scans. Ordered strings are implemented as null-terminated UTF-8 strings, so they
may not contain null characters.

**Value:** `TypeWrapper<string>`

### number · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the number type.

**Value:** `TypeWrapper<number>`

### dateTime · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the date/time type. Stored without timezone info, rounded to whole seconds.

**Value:** `TypeWrapper<Date>`

### boolean · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the boolean type.

**Value:** `TypeWrapper<boolean>`

### identifier · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the identifier type.

**Value:** `TypeWrapper<string>`

### undef · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Type wrapper instance for the 'undefined' type.

**Value:** `TypeWrapper<undefined>`

### opt · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create an optional type wrapper (allows undefined).

**Signature:** `<const T extends TypeWrapper<unknown> | BasicType>(inner: T) => TypeWrapper<T extends TypeWrapper<infer U> ? U : T>`

**Type Parameters:**

- `T extends TypeWrapper<unknown>|BasicType` - Type wrapper or basic type to make optional.

**Parameters:**

- `inner: T` - The inner type to make optional.

**Returns:** A union type that accepts the inner type or undefined.

**Examples:**

```typescript
const optionalString = E.opt(E.string);
const optionalNumber = E.opt(E.number);
```

### or · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create a union type wrapper from multiple type choices.

**Signature:** `<const T extends (TypeWrapper<unknown> | BasicType)[]>(...choices: T) => TypeWrapper<UnwrapTypes<T>>`

**Type Parameters:**

- `T extends (TypeWrapper<unknown>|BasicType)[]` - Array of type wrapper or basic types.

**Parameters:**

- `choices: T` - The type choices for the union.

**Returns:** A union type instance.

**Examples:**

```typescript
const stringOrNumber = E.or(E.string, E.number);
const status = E.or("active", "inactive", "pending");
```

### array · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create an array type wrapper with optional length constraints.

**Signature:** `<const T>(inner: TypeWrapper<T>, opts?: { min?: number; max?: number; }) => TypeWrapper<T[]>`

**Type Parameters:**

- `T` - The element type.

**Parameters:**

- `inner: TypeWrapper<T>` - Type wrapper for array elements.
- `opts: {min?: number, max?: number}` (optional) - Optional constraints (min/max length).

**Returns:** An array type instance.

**Examples:**

```typescript
const stringArray = E.array(E.string);
const boundedArray = E.array(E.number, {min: 1, max: 10});
```

### set · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create a Set type wrapper with optional length constraints.

**Signature:** `<const T>(inner: TypeWrapper<T>, opts?: { min?: number; max?: number; }) => TypeWrapper<Set<T>>`

**Type Parameters:**

- `T` - The element type.

**Parameters:**

- `inner: TypeWrapper<T>` - Type wrapper for set elements.
- `opts: {min?: number, max?: number}` (optional) - Optional constraints (min/max length).

**Returns:** A set type instance.

**Examples:**

```typescript
const stringSet = E.set(E.string);
const boundedSet = E.set(E.number, {min: 1, max: 10});
```

### record · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create a Record type wrapper for key-value objects with string or number keys.

**Signature:** `<const T>(inner: TypeWrapper<T>) => TypeWrapper<Record<string | number, T>>`

**Type Parameters:**

- `T` - The value type.

**Parameters:**

- `inner: TypeWrapper<T>` - Type wrapper for record values.

**Returns:** A record type instance.

**Examples:**

```typescript
const scores = E.record(E.number);  // Record<string | number, number>
```

### literal · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create a literal type wrapper for a constant value.

**Signature:** `<const T>(value: T) => TypeWrapper<T>`

**Type Parameters:**

- `T` - The literal type.

**Parameters:**

- `value: T` - The literal value.

**Returns:** A literal type instance.

**Examples:**

```typescript
const statusType = E.literal("active");
const countType = E.literal(42);
```

### link · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create a link type wrapper for model relationships.

**Signature:** `{ <const T extends new (...args: any[]) => Model<any>>(TargetModel: T): TypeWrapper<InstanceType<T>> & QueryArgCarrier<InstanceType<T> | LinkPrimaryKeyInput<LinkTargetPKArgs<T>>>; <const T extends new (...args: any[]) => Model<any>>(TargetModel: () => T): TypeWrapper<...>; }`

**Type Parameters:**

- `T extends new (...args: any[]) => Model<any>` - The target model class.

**Parameters:**

- `TargetModel: T` - The model class this link points to.

**Returns:** A link type instance.

**Examples:**

```typescript
const Author = E.defineModel("Author", class {
  id = E.field(E.identifier);
  posts = E.field(E.array(E.link(() => Book)));
}, { pk: "id" });

const Book = E.defineModel("Book", class {
  id = E.field(E.identifier);
  author = E.field(E.link(Author));
}, { pk: "id" });
```

### dump · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => void`

### FindOptions · [type](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L141)

Range-query options accepted by `find()`, `findBy()`, `batchProcess()`, and `batchProcessBy()`.

Supports exact-match lookups via `is`, inclusive bounds via `from` / `to`,
exclusive bounds via `after` / `before`, and reverse scans.

For single-field indexes, values can be passed directly. For composite indexes,
pass tuples or partial tuples for prefix matching. If an index field is a
`link(...)`, you may pass either the linked model instance or the linked
model's primary key. Composite linked primary keys are passed as tuples in
that slot.

**Type:** `(
    (
        {is: ArrayOrOnlyItem<ARG_TYPES>;} // Shortcut for setting `from` and `to` to the same value
    |
        (
            (
                {from: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {after: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {}
            )
        &
            (
                {to: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {before: ArrayOrOnlyItem<ARG_TYPES>;}
            |
                {}
            )
        )
    ) &
    {
        reverse?: boolean;
    }
    & (FETCH extends undefined ? { fetch?: undefined } : { fetch: FETCH })
)`

### IndexRangeIterator · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L90)

Iterator for range queries on indexes.
Handles common iteration logic for both primary and unique indexes.
Extends built-in Iterator to provide map/filter/reduce/toArray/etc.

**Type Parameters:**

- `ITEM`

#### indexRangeIterator.[Symbol.iterator] · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L100)

**Signature:** `() => this`

#### indexRangeIterator.next · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L102)

**Signature:** `() => IteratorResult<ITEM, any>`

#### indexRangeIterator.count · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L110)

**Signature:** `() => number`

#### indexRangeIterator.fetch · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L112)

**Signature:** `() => ITEM`

### Change · [type](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L93)

**Type:** `Record<any, any> | "created" | "deleted"`

### FieldConfig · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L40)

Configuration interface for model fields.

**Type Parameters:**

- `T` - The field type.

#### fieldConfig.type · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L45)

The type wrapper that defines how this field is serialized/validated.

**Type:** `TypeWrapper<T>`

#### fieldConfig.description · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L48)

Optional human-readable description of the field.

**Type:** `string`

#### fieldConfig.default · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L51)

Optional default value or function that generates default values.

**Type:** `T | ((model: Record<string, any>) => T)`

### TypeWrapper · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L36)

**Type Parameters:**

- `T` - The TypeScript type this wrapper represents.

#### typeWrapper.kind · [abstract property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L48)

A string identifier for this type, used during serialization

**Type:** `string`

#### typeWrapper.serialize · [abstract method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L52)

Serialize a value from an object property to a Pack.

**Signature:** `(value: T, pack: DataPack) => void`

**Parameters:**

- `value: T` - The value to serialize.
- `pack: DataPack` - The Pack instance to write to.

#### typeWrapper.deserialize · [abstract method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L59)

Deserialize a value from a Pack into an object property.

**Signature:** `(pack: DataPack) => T`

**Parameters:**

- `pack: DataPack` - The Pack instance to read from.

#### typeWrapper.getError · [abstract method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L66)

Validate a value.

**Signature:** `(value: T) => void | DatabaseError`

**Parameters:**

- `value: T` - The value to validate.

**Returns:** - A DatabaseError if validation fails.

#### typeWrapper.serializeType · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L68)

Serialize type metadata to a Pack (for schema serialization).

**Signature:** `(pack: DataPack) => void`

**Parameters:**

- `pack: DataPack` - The Pack instance to write to.

#### typeWrapper.containsNull · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L78)

Check if indexing should be skipped for this field value.

**Signature:** `(value: T) => boolean`

**Parameters:**

- `value: T`

**Returns:** true if indexing should be skipped.

#### typeWrapper.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L79)

**Signature:** `() => string`

#### typeWrapper.clone · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L83)

**Signature:** `(value: T) => T`

**Parameters:**

- `value: T`

#### typeWrapper.equals · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L86)

**Signature:** `(value1: T, value2: T) => boolean`

**Parameters:**

- `value1: T`
- `value2: T`

#### typeWrapper.getLinkedModel · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L90)

**Signature:** `() => AnyModelClass`

### DatabaseError · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L182)

The DatabaseError class is used to represent errors that occur during database operations.
It extends the built-in Error class and has a machine readable error code string property.

The lowlevel API will throw DatabaseError instances for all database-related errors.
Invalid function arguments will throw TypeError.

**Value:** `DatabaseErrorConstructor`

### runMigration · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L121)

Run database migration: populate secondary indexes for old-version rows,
convert old primary indices, rewrite row data, and clean up orphaned indices.

**Signature:** `(options?: MigrationOptions) => Promise<MigrationResult>`

**Parameters:**

- `options: MigrationOptions` (optional)

### MigrationOptions · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L13)

#### migrationOptions.tables · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L18)

Limit migration to specific table names.

**Type:** `string[]`

#### migrationOptions.populateSecondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L22)

Populate secondary indexes for rows at old schema versions (default: true).

**Type:** `boolean`

#### migrationOptions.migratePrimaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L29)

Convert old primary indices when primary key fields changed (default: true).

**Type:** `boolean`

#### migrationOptions.rewriteData · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L38)

Rewrite all row data to the latest schema version (default: false).

**Type:** `boolean`

#### migrationOptions.removeOrphans · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L45)

Delete orphaned secondary/unique index entries (default: true).

**Type:** `boolean`

#### migrationOptions.onProgress · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L45)

Progress callback.

**Type:** `(info: ProgressInfo) => void`

### MigrationResult · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L50)

#### migrationResult.secondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L52)

Per-table counts of secondary index entries populated.

**Type:** `Record<string, number>`

#### migrationResult.primaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L56)

Per-table counts of old primary rows migrated.

**Type:** `Record<string, number>`

#### migrationResult.conversionFailures · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L59)

Per-table conversion failure counts by reason.

**Type:** `Record<string, Record<string, number>>`

#### migrationResult.rewritten · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L63)

Per-table counts of rows rewritten to latest version.

**Type:** `Record<string, number>`

#### migrationResult.orphans · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L67)

Number of orphaned index entries deleted.

**Type:** `number`

### Transaction · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L54)

#### transaction.id · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L55)

**Type:** `number`

#### transaction.instances · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L56)

**Type:** `Map<number, ModelBase>`

### txnStorage · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L59)

**Value:** `AsyncLocalStorage<Transaction>`

