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

const User = E.defineModel(class {
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
        byEmail: "email",
    },
    tableName: "User",
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
    const john = User.byEmail.get("john@example.com")!;

    // The transaction will retry if there's a conflict, such as another transaction
    // modifying the same user (from another async function or another process)
    john.age++;

    // The supervisor object is lazy loaded on first access
    console.log(`${john.supervisor!.name} is ${john.name}'s supervisor`);
});    
```

## Tutorial


### Defining Models

Models are plain, usually anonymous, classes passed to `E.defineModel()`:

```typescript
import * as E from "edinburgh";

const User = E.defineModel(class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
  age = E.field(E.number);
}, {
  pk: "id",
  unique: {
    byEmail: "email",
  },
});
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
const Post = E.defineModel(class {
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
  const user = User.byEmail.get("alice@example.com");
  if (user) user.age++;
});

// Return values from transactions
const name = await E.transact(() => {
  const user = User.byEmail.get("alice@example.com");
  return user?.name;
});
```

Transactions auto-retry on conflict (up to 6 times by default). Keep transaction functions idempotent.

### Indexes

Edinburgh supports three index types:

```typescript
const Product = E.defineModel(class {
  sku = E.field(E.string);
  name = E.field(E.string);
  category = E.field(E.string);
  price = E.field(E.number);
}, {
  pk: "sku",
  unique: { byName: "name" },
  index: { byCategory: "category" },
});
```

If no `pk` is provided, Edinburgh auto-creates one on an `id` field, adding it as an `E.identifier` field if needed.

#### Lookups

```typescript
await E.transact(() => {
  // Primary key lookup
  const p1 = Product.get("SKU-001");

  // Unique index lookup
  const p2 = Product.byName.get("Widget");

  // All return undefined if not found
});
```

#### Range Queries

All index types support `.find()` for range iteration:

```typescript
await E.transact(() => {
  // Exact match
  for (const p of Product.byCategory.find({is: "electronics"})) {
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
  const count = Product.byCategory.find({is: "electronics"}).count();
  const first = Product.byCategory.find({is: "electronics"}).fetch(); // first match or undefined
});
```

#### Composite Primary Keys

```typescript
const Event = E.defineModel(class {
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
const User = E.defineModel(class {
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
const Article = E.defineModel(class {
  id = E.field(E.identifier);
  firstName = E.field(E.string);
  lastName = E.field(E.string);
  title = E.field(E.string);
  email = E.field(E.opt(E.string));
}, {
  pk: "id",
  unique: {
    byFullName: (a: any) => [`${a.firstName} ${a.lastName}`], // computed covering unique index
  },
  index: {
    byDomain: (a: any) => a.email ? [a.email.split("@")[1]] : [], // computed partial index
    byWord: (a: any) => a.title.toLowerCase().split(" "), // computed multi-index
  },
});

await E.transact(() => {
  new Article({ firstName: "Jane", lastName: "Doe", title: "Hello World", email: "jane@acme.com" });

  // Lookup via computed unique index
  const jane = Article.byFullName.get("Jane Doe");

  // Multi-value: each word in the title is indexed separately
  for (const a of Article.byWord.find({is: "hello"})) { ... }

  // Partial index: articles without email are skipped
  for (const a of Article.byDomain.find({is: "acme.com"})) { ... }
});
```

### Relationships

Use `E.link(Model)` for foreign keys. Use a thunk (a function that just returns a value) for forward references when needed:

```typescript
const Author = E.defineModel(class {
  id = E.field(E.identifier);
  name = E.field(E.string);
}, { pk: "id" });

const Book = E.defineModel(class {
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
const UserV2 = E.defineModel(class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  role = E.field(E.string);  // newly added field

  static migrate(record: Record<string, any>) {
    record.role ??= record.name.indexOf("admin") >= 0 ? "admin" : "user"; // set role based on name for old records
  }
}
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
const Article = E.defineModel(class {
  id = E.field(E.identifier);
  title = E.field(E.string);
  slug = E.field(E.string);

  preCommit() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }
}, { pk: "id" });
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

### scheduleInit · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L6)

**Signature:** `() => void`

### init · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L65)

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

### transact · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L116)

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

- `fn: () => T` - - The function to execute within the transaction context. Receives a Transaction instance.

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

### setMaxRetryCount · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L206)

Set the maximum number of retries for a transaction in case of conflicts.
The default value is 6. Setting it to 0 will disable retries and cause transactions to fail immediately on conflict.

**Signature:** `(count: number) => void`

**Parameters:**

- `count: number` - The maximum number of retries for a transaction.

### setOnSaveCallback · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L220)

Set a callback function to be called after a model is saved and committed.

**Signature:** `(callback: (commitId: number, items: Map<Model<any>, Change>) => void) => void`

**Parameters:**

- `callback: ((commitId: number, items: Map<Model<any>, Change>) => void) | undefined` - The callback function to set. It gets called after each successful
`transact()` commit that has changes, with the following arguments:
- A sequential number. Higher numbers have been committed after lower numbers.
- A map of model instances to their changes. The change can be "created", "deleted", or an object containing the old values.

### deleteEverything · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L225)

**Signature:** `() => Promise<void>`

### Model · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

[object Object],[object Object],[object Object],[object Object],[object Object]

**Type Parameters:**

- `SUB` - The concrete model subclass (for proper typing).

**Examples:**

```typescript
const User = E.defineModel(class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
}, {
  pk: "id",
  unique: { byEmail: "email" },
});
```

#### Model.tableName · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

The database table name (defaults to class name).

**Type:** `string`

#### Model.override · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

When true, defineModel replaces an existing model with the same tableName.

**Type:** `boolean`

#### Model.fields · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Field configuration metadata.

**Type:** `Record<string | number | symbol, FieldConfig<unknown>>`

#### Model.migrate · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Optional migration function called when deserializing rows written with an older schema version.
Receives a plain record with all fields (primary key fields + value fields) and should mutate it
in-place to match the current schema.

This is called both during lazy loading (when a row is read from disk) and during batch
migration (via `runMigration()` / `npx migrate-edinburgh`). The function's source code is hashed
to detect changes. Modifying `migrate()` triggers a new schema version.

If `migrate()` changes values of fields used in secondary or unique indexes, those indexes
will only be updated when `runMigration()` is run (not during lazy loading).

**Signature:** `(record: Record<string, any>) => void`

**Parameters:**

- `record: Record<string, any>` - - A plain object with all field values from the old schema version.

**Examples:**

```typescript
const User = E.defineModel(class {
  id = E.field(E.identifier);
  name = E.field(E.string);
  role = E.field(E.string);  // new field

  static migrate(record: Record<string, any>) {
    record.role ??= "user";  // default for rows that predate the 'role' field
  }
}, { pk: "id" });
```

#### Model.get · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(...args: any[]) => any`

**Parameters:**

- `args: any[]`

#### Model.getLazy · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(...args: any[]) => any`

**Parameters:**

- `args: any[]`

#### Model.find · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(opts?: any) => any`

**Parameters:**

- `opts?: any`

#### Model.batchProcess · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(opts: any, callback?: any) => any`

**Parameters:**

- `opts: any`
- `callback?: any`

#### Model.replaceInto · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Load an existing instance by primary key and update it, or create a new one.

The provided object must contain all primary key fields. If a matching row exists,
the remaining properties from `obj` are set on the loaded instance. Otherwise a
new instance is created with `obj` as its initial properties.

**Signature:** `<T extends typeof Model<any>>(this: T, obj: Partial<Record<string, any>>) => InstanceType<T>`

**Parameters:**

- `this: T`
- `obj: Partial<Record<string, any>>` - - Partial model data that **must** include every primary key field.

**Returns:** The loaded-and-updated or newly created instance.

#### model.preCommit · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

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
const Post = E.defineModel(class {
  id = E.field(E.identifier);
  title = E.field(E.string);
  slug = E.field(E.string);

  preCommit() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }
}, { pk: "id" });
```

#### model.getPrimaryKey · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => Uint8Array<ArrayBufferLike>`

**Returns:** The primary key for this instance.

#### model.getPrimaryKeyHash · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => number`

**Returns:** A 53-bit positive integer non-cryptographic hash of the primary key, or undefined if not yet saved.

#### model.isLazyField · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(field: keyof this) => boolean`

**Parameters:**

- `field: keyof this`

#### model.preventPersist · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Prevent this instance from being persisted to the database.

**Signature:** `() => this`

**Returns:** This model instance for chaining.

**Examples:**

```typescript
const user = User.get("user123");
user.name = "New Name";
user.preventPersist(); // Changes won't be saved
```

#### model.delete · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Delete this model instance from the database.

Removes the instance and all its index entries from the database and prevents further persistence.

**Signature:** `() => void`

**Examples:**

```typescript
const user = User.get("user123");
user.delete(); // Removes from database
```

#### model.validate · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Validate all fields in this model instance.

**Signature:** `(raise?: boolean) => Error[]`

**Parameters:**

- `raise: boolean` (optional) - - If true, throw on first validation error.

**Returns:** Array of validation errors (empty if valid).

**Examples:**

```typescript
const user = new User();
const errors = user.validate();
if (errors.length > 0) {
  console.log("Validation failed:", errors);
}
```

#### model.isValid · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Check if this model instance is valid.

**Signature:** `() => boolean`

**Returns:** true if all validations pass.

**Examples:**

```typescript
const user = new User({name: "John"});
if (!user.isValid()) shoutAtTheUser();
```

#### model.getState · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => "created" | "deleted" | "loaded" | "lazy"`

#### model.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => string`

#### model.[Symbol.for('nodejs.util.inspect.custom')] · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => string`

### defineModel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L164)

Register a model class with the Edinburgh ORM system.

Converts a plain class into a fully-featured model with database persistence,
typed fields, primary key access, and optional secondary and unique indexes.

**Signature:** `<T extends new () => any, const PK extends (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[], const UNIQUE extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>, const INDEX extends Record<string, (keyof FieldsOf<T> & string) | ...`

**Type Parameters:**

- `T extends new () => any`
- `PK extends (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[]`
- `UNIQUE extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>`
- `INDEX extends Record<string, (keyof FieldsOf<T> & string) | readonly (keyof FieldsOf<T> & string)[] | ((instance: any) => any)>`

**Parameters:**

- `cls: T` - - A plain class whose properties use E.field().
- `opts?: { pk?: PK, unique?: UNIQUE, index?: INDEX, tableName?: string, override?: boolean }` - - Registration options.

**Returns:** The enhanced model constructor.

### field · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L87)

Create a field definition for a model property.

This function uses TypeScript magic to return the field configuration object
while appearing to return the actual field value type to the type system.
This allows for both runtime introspection and compile-time type safety.

**Signature:** `<T>(type: TypeWrapper<T>, options?: Partial<FieldConfig<T>>) => T`

**Type Parameters:**

- `T` - The field type.

**Parameters:**

- `type: TypeWrapper<T>` - - The type wrapper for this field.
- `options: Partial<FieldConfig<T>>` (optional) - - Additional field configuration options.

**Returns:** The field value (typed as T, but actually returns FieldConfig<T>).

**Examples:**

```typescript
const User = E.defineModel(class {
  name = E.field(E.string, {description: "User's full name"});
  age = E.field(E.opt(E.number), {description: "User's age", default: 25});
});
```

### currentTxn · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L21)

Returns the current transaction from AsyncLocalStorage.
Throws if called outside a transact() callback.

**Signature:** `() => Transaction`

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

- `inner: T` - - The inner type to make optional.

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

- `choices: T` - - The type choices for the union.

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

- `inner: TypeWrapper<T>` - - Type wrapper for array elements.
- `opts: {min?: number, max?: number}` (optional) - - Optional constraints (min/max length).

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

- `inner: TypeWrapper<T>` - - Type wrapper for set elements.
- `opts: {min?: number, max?: number}` (optional) - - Optional constraints (min/max length).

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

- `inner: TypeWrapper<T>` - - Type wrapper for record values.

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

- `value: T` - - The literal value.

**Returns:** A literal type instance.

**Examples:**

```typescript
const statusType = E.literal("active");
const countType = E.literal(42);
```

### link · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Create a link type wrapper for model relationships.

**Signature:** `{ <const T extends ModelCtorLike>(TargetModel: T): TypeWrapper<InstanceType<T>>; <const T extends ModelCtorLike>(TargetModel: () => T): TypeWrapper<InstanceType<T>>; }`

**Type Parameters:**

- `T extends ModelCtorLike` - The target model class.

**Parameters:**

- `TargetModel: T` - - The model class this link points to.

**Returns:** A link type instance.

**Examples:**

```typescript
const Author = E.defineModel(class {
  id = E.field(E.identifier);
  posts = E.field(E.array(E.link(() => Book)));
}, { pk: "id" });

const Book = E.defineModel(class {
  id = E.field(E.identifier);
  author = E.field(E.link(Author));
}, { pk: "id" });
```

### dump · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Dump database contents for debugging.

Prints all indexes and their data to the console for inspection.
This is primarily useful for development and debugging purposes.

**Signature:** `() => void`

### BaseIndex · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L130)

Base class for database indexes for efficient lookups on model fields.

Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

**Constructor Parameters:**

- `MyModel`: - The model class this index belongs to.
- `_fieldNames`: - Array of field names that make up this index.

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `{ (opts?: FindOptions<ARGS, "first">): InstanceType<M>; (opts: FindOptions<ARGS, "single">): InstanceType<M>; (opts?: FindOptions<...>): IndexRangeIterator<...>; }`

**Parameters:**

- `opts?: FindOptions<ARGS, 'first'>`

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `{ (opts?: FindOptions<ARGS, "first">): InstanceType<M>; (opts: FindOptions<ARGS, "single">): InstanceType<M>; (opts?: FindOptions<...>): IndexRangeIterator<...>; }`

**Parameters:**

- `opts: FindOptions<ARGS, 'single'>`

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `{ (opts?: FindOptions<ARGS, "first">): InstanceType<M>; (opts: FindOptions<ARGS, "single">): InstanceType<M>; (opts?: FindOptions<...>): IndexRangeIterator<...>; }`

**Parameters:**

- `opts?: FindOptions<ARGS>`

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `{ (opts?: FindOptions<ARGS, "first">): InstanceType<M>; (opts: FindOptions<ARGS, "single">): InstanceType<M>; (opts?: FindOptions<...>): IndexRangeIterator<...>; }`

**Parameters:**

- `opts: any` (optional)

#### baseIndex.batchProcess · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

[object Object],[object Object],[object Object]

**Signature:** `(opts: FindOptions<ARGS, undefined> & { limitSeconds?: number; limitRows?: number; }, callback: (row: InstanceType<M>) => void | Promise<void>) => Promise<...>`

**Parameters:**

- `opts: FindOptions<ARGS> & { limitSeconds?: number; limitRows?: number }` (optional) - - Query options (same as `find()`), plus:
- `callback: (row: InstanceType<M>) => void | Promise<void>` - - Called for each matching row within a transaction

#### baseIndex.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `() => string`

### NonPrimaryIndex · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Abstract base for all non-primary indexes (unique and secondary).
Provides shared key serialization, write/delete/update logic.

**Type Parameters:**

- `M extends typeof Model`
- `F extends readonly (keyof InstanceType<M> & string)[]`
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

### UniqueIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Unique index that stores references to the primary key.

**Type Parameters:**

- `M extends typeof Model`
- `F extends readonly (keyof InstanceType<M> & string)[]`
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

#### uniqueIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

**Signature:** `(...args: ARGS) => InstanceType<M>`

**Parameters:**

- `args: ARGS`

### SecondaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L252)

Secondary index for non-unique lookups.

**Type Parameters:**

- `M extends typeof Model`
- `F extends readonly (keyof InstanceType<M> & string)[]`
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

### Change · [type](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L94)

**Type:** `Record<any, any> | "created" | "deleted"`

### Transaction · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L39)

#### transaction.id · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L41)

**Type:** `number`

#### transaction.instances · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L42)

**Type:** `Set<Model<unknown>>`

#### transaction.instancesByPk · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L44)

**Type:** `Map<number, Model<unknown>>`

### DatabaseError · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L156)

The DatabaseError class is used to represent errors that occur during database operations.
It extends the built-in Error class and has a machine readable error code string property.

The lowlevel API will throw DatabaseError instances for all database-related errors.
Invalid function arguments will throw TypeError.

**Value:** `DatabaseErrorConstructor`

### runMigration · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L122)

Run database migration: populate secondary indexes for old-version rows,
convert old primary indices, rewrite row data, and clean up orphaned indices.

**Signature:** `(options?: MigrationOptions) => Promise<MigrationResult>`

**Parameters:**

- `options: MigrationOptions` (optional)

### MigrationOptions · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L13)

#### migrationOptions.tables · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L17)

Limit migration to specific table names.

**Type:** `string[]`

#### migrationOptions.populateSecondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L21)

Populate secondary indexes for rows at old schema versions (default: true).

**Type:** `boolean`

#### migrationOptions.migratePrimaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L29)

Convert old primary indices when primary key fields changed (default: true).

**Type:** `boolean`

#### migrationOptions.rewriteData · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L37)

Rewrite all row data to the latest schema version (default: false).

**Type:** `boolean`

#### migrationOptions.removeOrphans · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L44)

Delete orphaned secondary/unique index entries (default: true).

**Type:** `boolean`

#### migrationOptions.onProgress · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L44)

Progress callback.

**Type:** `(info: ProgressInfo) => void`

### MigrationResult · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L49)

#### migrationResult.secondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L50)

Per-table counts of secondary index entries populated.

**Type:** `Record<string, number>`

#### migrationResult.primaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L56)

Per-table counts of old primary rows migrated.

**Type:** `Record<string, number>`

#### migrationResult.conversionFailures · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L57)

Per-table conversion failure counts by reason.

**Type:** `Record<string, Record<string, number>>`

#### migrationResult.rewritten · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L60)

Per-table counts of rows rewritten to latest version.

**Type:** `Record<string, number>`

#### migrationResult.orphans · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L65)

Number of orphaned index entries deleted.

**Type:** `number`

