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

// Define a model
@E.registerModel
class User extends E.Model<User> {
    // Define a primary key (optional, defaults to using the "id" field)
    static pk = E.primary(User, "id");
    // Define a unique index on the email field
    static byEmail = E.unique(User, "email");

    // Define fields with simple types -- they will be type-checked at compile time and validated at runtime.
    id = E.field(E.identifier);
    name = E.field(E.string);
    age = E.field(E.number);
    email = E.field(E.opt(E.string)); // TypeScript: undefined | string

    // Link to another instance of this model
    supervisor = E.field(E.opt(E.link(User)));

    // A field with a more elaborate type. In TypeScript: `User | User[] | "unknown" | "whatever"`
    something = E.field(E.or(E.link(User), E.array(E.link(User)), E.literal("unknown"), E.literal("whatever")), { default: "unknown" });
}

// Use in transactions
await E.transact(() => {
    const boss = new User({
        name: "Big Boss",
        age: 50,
    });
    const john = new User({ // Unique 'id' is automatically generated if not provided
        name: "John Doe", 
        age: 41,
        email: "john@example.com",
        supervisor: boss, // Link to another model instance
    });
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

### TypeScript Configuration

When using TypeScript to transpile to JavaScript, make sure to enable the following options in your `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "es2022",
        "experimentalDecorators": true
    }
}
```

### Defining Models

Models are classes that extend `E.Model<Self>` and use the `@E.registerModel` decorator:

```typescript
import * as E from "edinburgh";

@E.registerModel
class User extends E.Model<User> {
  static pk = E.primary(User, "id");

  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
  age = E.field(E.number);
}
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
@E.registerModel
class Post extends E.Model<Post> {
  static pk = E.primary(Post, "id");

  id = E.field(E.identifier);  // auto-generated
  title = E.field(E.string);
  status = E.field(E.or("draft", "published"), {default: "draft"});
  tags = E.field(E.array(E.string), {default: () => []});  // use function for mutable defaults
  createdAt = E.field(E.dateTime);  // dateTime defaults to new Date()
}
```

### Transactions

All database operations must run inside `E.transact()`:

```typescript
// Initialize (optional — defaults to ".edinburgh" directory)
E.init("./my-database");

// Create
await E.transact(() => {
  const user = new User({name: "Alice", email: "alice@example.com", age: 30});
  // user.id is auto-generated
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
@E.registerModel
class Product extends E.Model<Product> {
  static pk = E.primary(Product, "sku");           // primary: one per model, stores data
  static byName = E.unique(Product, "name");       // unique: enforces uniqueness + fast lookup
  static byCategory = E.index(Product, "category");// secondary: non-unique, for queries

  sku = E.field(E.string);
  name = E.field(E.string);
  category = E.field(E.string);
  price = E.field(E.number);
}
```

If no `E.primary()` is declared, Edinburgh auto-creates one on an `id` field (adding `E.identifier` if missing).

#### Lookups

```typescript
await E.transact(() => {
  // Primary key lookup
  const p = Product.pk.get("SKU-001");

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
  for (const p of Product.pk.find({from: "A", to: "M"})) {
    console.log(p.sku);
  }

  // Exclusive bounds
  for (const p of Product.pk.find({after: "A", before: "M"})) { ... }

  // Open-ended
  for (const p of Product.pk.find({from: "M"})) { ... }

  // Reverse
  for (const p of Product.pk.find({reverse: true})) { ... }

  // Count and fetch helpers
  const count = Product.byCategory.find({is: "electronics"}).count();
  const first = Product.byCategory.find({is: "electronics"}).fetch(); // first match or undefined
});
```

#### Composite Indexes

```typescript
@E.registerModel
class Event extends E.Model<Event> {
  static pk = E.primary(Event, ["year", "month", "id"]);

  year = E.field(E.number);
  month = E.field(E.number);
  id = E.field(E.identifier);
  title = E.field(E.string);
}

await E.transact(() => {
  // Prefix matching — find all events in 2025
  for (const e of Event.pk.find({is: [2025]})) { ... }

  // Find events in March 2025
  for (const e of Event.pk.find({is: [2025, 3]})) { ... }
});
```

#### Non-Persistent Properties

You can freely add regular methods, getters, and other non-persistent properties to model classes. These work normally in JavaScript but are **not stored in the database** and **not synchronized** across transactions or processes.

```typescript
@E.registerModel
class User extends E.Model<User> {
  static pk = E.primary(User, "id");
  id = E.field(E.identifier);
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
}
```

#### Computed Indexes

Instead of naming fields, you can pass a **function** to `E.unique()` or `E.index()`. The function receives a model instance and returns an **array** of index key values. Each element creates a separate index entry, enabling multi-value indexes. Return `[]` to skip indexing for that instance (partial index).

```typescript
@E.registerModel
class Article extends E.Model<Article> {
  static pk = E.primary(Article, "id");
  static byFullName = E.unique(Article, (a: Article) => [`${a.firstName} ${a.lastName}`]);
  static byWord = E.index(Article, (a: Article) => a.title.toLowerCase().split(" "));
  static byDomain = E.index(Article, (a: Article) => a.email ? [a.email.split("@")[1]] : []);

  id = E.field(E.identifier);
  firstName = E.field(E.string);
  lastName = E.field(E.string);
  title = E.field(E.string);
  email = E.field(E.opt(E.string));
}

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

Computed indexes also support `find()` range queries and `batchProcess()`, just like field-based indexes.

### Relationships (Links)

Use `E.link(Model)` for foreign keys:

```typescript
@E.registerModel
class Author extends E.Model<Author> {
  static pk = E.primary(Author, "id");
  id = E.field(E.identifier);
  name = E.field(E.string);
}

@E.registerModel
class Book extends E.Model<Book> {
  static pk = E.primary(Book, "id");
  id = E.field(E.identifier);
  title = E.field(E.string);
  author = E.field(E.link(Author));
}

await E.transact(() => {
  const author = new Author({name: "Tolkien"});
  const book = new Book({title: "The Hobbit", author});

  // Later: linked models are lazy-loaded on property access
  const b = Book.pk.get(book.id)!;
  console.log(b.author.name);  // loads Author automatically (~1µs)
});
```

### Deleting

```typescript
await E.transact(() => {
  const user = User.pk.get(someId);
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

// findAll iterates all instances
await E.transact(() => {
  for (const user of User.findAll()) { ... }
  for (const user of User.findAll({reverse: true})) { ... }
});

// replaceInto: upsert by primary key
await E.transact(() => {
  User.replaceInto({id: existingId, name: "Updated Name", email: "new@example.com", age: 30});
});
```

### Batch Processing

For large datasets, `batchProcess` auto-commits in batches:

```typescript
await Product.byCategory.batchProcess({is: "old"}, (product) => {
  product.category = "archived";
});
// Commits every ~1 second or 4096 rows (configurable via limitSeconds, limitRows)
```

### Lazy Schema Migrations

When you change a model's schema, Edinburgh will lazily try to migrate old records on access. This allows you to deploy code changes without downtime or a separate migration step. Optionally, you may provide a `static migrate(record: Record<string, any>)` function on the model to transform old records during lazy migration. If there is a migration error (like a new field without a default value, or an incompatible type change), a run-time error is thrown when loading the affected model instance.

```typescript
@E.registerModel
class User extends E.Model<User> {
  static pk = E.primary(User, "id");
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
@E.registerModel
class Article extends E.Model<Article> {
  static pk = E.primary(Article, "id");
  id = E.field(E.identifier);
  title = E.field(E.string);
  slug = E.field(E.string);

  preCommit() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }
}
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

### init · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L67)

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

### transact · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L118)

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
  const user = User.pk.get("john_doe");
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
  const counter = Counter.pk.get("global") || new Counter({id: "global", value: 0});
  counter.value++;
});
```

### setMaxRetryCount · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L208)

Set the maximum number of retries for a transaction in case of conflicts.
The default value is 6. Setting it to 0 will disable retries and cause transactions to fail immediately on conflict.

**Signature:** `(count: number) => void`

**Parameters:**

- `count: number` - The maximum number of retries for a transaction.

### setOnSaveCallback · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L222)

Set a callback function to be called after a model is saved and committed.

**Signature:** `(callback: (commitId: number, items: Map<Model<any>, Change>) => void) => void`

**Parameters:**

- `callback: ((commitId: number, items: Map<Model<any>, Change>) => void) | undefined` - The callback function to set. It gets called after each successful
`transact()` commit that has changes, with the following arguments:
- A sequential number. Higher numbers have been committed after lower numbers.
- A map of model instances to their changes. The change can be "created", "deleted", or an object containing the old values.

### deleteEverything · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L227)

**Signature:** `() => Promise<void>`

### Model · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L220)

[object Object],[object Object],[object Object],[object Object],[object Object]

**Type Parameters:**

- `SUB` - The concrete model subclass (for proper typing).

**Examples:**

```typescript
⁣@E.registerModel
class User extends E.Model<User> {
  static pk = E.primary(User, "id");
  
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
  
  static byEmail = E.unique(User, "email");
}
```

#### Model.tableName · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L227)

The database table name (defaults to class name).

**Type:** `string`

#### Model.override · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L231)

When true, registerModel replaces an existing model with the same tableName.

**Type:** `boolean`

#### Model.fields · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L232)

Field configuration metadata.

**Type:** `Record<string | number | symbol, FieldConfig<unknown>>`

#### Model.migrate · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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
⁣@E.registerModel
class User extends E.Model<User> {
  static pk = E.primary(User, "id");
  id = E.field(E.identifier);
  name = E.field(E.string);
  role = E.field(E.string);  // new field

  static migrate(record: Record<string, any>) {
    record.role ??= "user";  // default for rows that predate the 'role' field
  }
}
```

#### Model.findAll · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Find all instances of this model in the database, ordered by primary key.

**Signature:** `<T extends typeof Model<unknown>>(this: T, opts?: { reverse?: boolean; }) => IndexRangeIterator<T>`

**Parameters:**

- `this: T`
- `opts?: {reverse?: boolean}` - - Optional parameters.

**Returns:** An iterator.

#### Model.replaceInto · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Load an existing instance by primary key and update it, or create a new one.

The provided object must contain all primary key fields. If a matching row exists,
the remaining properties from `obj` are set on the loaded instance. Otherwise a
new instance is created with `obj` as its initial properties.

**Signature:** `<T extends typeof Model<any>>(this: T, obj: Partial<Omit<InstanceType<T>, "constructor">>) => InstanceType<T>`

**Parameters:**

- `this: T`
- `obj: Partial<Omit<InstanceType<T>, "constructor">>` - - Partial model data that **must** include every primary key field.

**Returns:** The loaded-and-updated or newly created instance.

#### model.preCommit · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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
⁣@E.registerModel
class Post extends E.Model<Post> {
  static pk = E.primary(Post, "id");
  id = E.field(E.identifier);
  title = E.field(E.string);
  slug = E.field(E.string);

  preCommit() {
    this.slug = this.title.toLowerCase().replace(/\s+/g, "-");
  }
}
```

#### model.getPrimaryKey · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `() => Uint8Array<ArrayBufferLike>`

**Returns:** The primary key for this instance.

#### model.getPrimaryKeyHash · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `() => number`

**Returns:** A 53-bit positive integer non-cryptographic hash of the primary key, or undefined if not yet saved.

#### model.isLazyField · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `(field: keyof this) => boolean`

**Parameters:**

- `field: keyof this`

#### model.preventPersist · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Prevent this instance from being persisted to the database.

**Signature:** `() => this`

**Returns:** This model instance for chaining.

**Examples:**

```typescript
const user = User.load("user123");
user.name = "New Name";
user.preventPersist(); // Changes won't be saved
```

#### model.delete · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Delete this model instance from the database.

Removes the instance and all its index entries from the database and prevents further persistence.

**Signature:** `() => void`

**Examples:**

```typescript
const user = User.load("user123");
user.delete(); // Removes from database
```

#### model.validate · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

#### model.isValid · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Check if this model instance is valid.

**Signature:** `() => boolean`

**Returns:** true if all validations pass.

**Examples:**

```typescript
const user = new User({name: "John"});
if (!user.isValid()) shoutAtTheUser();
```

#### model.getState · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `() => "created" | "deleted" | "loaded" | "lazy"`

#### model.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `() => string`

#### model.[Symbol.for('nodejs.util.inspect.custom')] · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `() => string`

### registerModel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L113)

Register a model class with the Edinburgh ORM system.

**Signature:** `<T extends typeof Model<unknown>>(MyModel: T) => T`

**Type Parameters:**

- `T extends typeof Model<unknown>` - The model class type.

**Parameters:**

- `MyModel: T` - - The model class to register.

**Returns:** The enhanced model class with ORM capabilities.

**Examples:**

```typescript
⁣@E.registerModel
class User extends E.Model<User> {
  static pk = E.index(User, ["id"], "primary");
  id = E.field(E.identifier);
  name = E.field(E.string);
}
```

### field · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L89)

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
class User extends E.Model<User> {
  name = E.field(E.string, {description: "User's full name"});
  age = E.field(E.opt(E.number), {description: "User's age", default: 25});
}
```

### string · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the string type.

**Value:** `TypeWrapper<string>`

### orderedString · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the ordered string type, which is just like a string
except that it sorts lexicographically in the database (instead of by incrementing
length first), making it suitable for index fields that want lexicographic range
scans. Ordered strings are implemented as null-terminated UTF-8 strings, so they
may not contain null characters.

**Value:** `TypeWrapper<string>`

### number · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the number type.

**Value:** `TypeWrapper<number>`

### dateTime · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the date/time type. Stored without timezone info, rounded to whole seconds.

**Value:** `TypeWrapper<Date>`

### boolean · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the boolean type.

**Value:** `TypeWrapper<boolean>`

### identifier · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the identifier type.

**Value:** `TypeWrapper<string>`

### undef · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Type wrapper instance for the 'undefined' type.

**Value:** `TypeWrapper<undefined>`

### opt · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

### or · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

### array · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

### set · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

### record · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

### literal · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

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

### link · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Create a link type wrapper for model relationships.

**Signature:** `<const T extends typeof Model<any>>(TargetModel: T) => TypeWrapper<InstanceType<T>>`

**Type Parameters:**

- `T extends typeof Model<any>` - The target model class.

**Parameters:**

- `TargetModel: T` - - The model class this link points to.

**Returns:** A link type instance.

**Examples:**

```typescript
class User extends E.Model<User> {
  posts = E.field(E.array(E.link(Post, 'author')));
}

class Post extends E.Model<Post> {
  author = E.field(E.link(User));
}
```

### index · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Create a secondary index on model fields, or a computed secondary index using a function.

For field-based indexes, pass a field name or array of field names.
For computed indexes, pass a function that takes a model instance and returns an array of
index keys. Return `[]` to skip indexing for that instance. Each array element creates a
separate index entry, enabling multi-value indexes (e.g., indexing by each word in a name).

**Signature:** `{ <M extends typeof Model, V>(MyModel: M, fn: (instance: InstanceType<M>) => V[]): SecondaryIndex<M, [], [V]>; <M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): SecondaryIndex<...>; <M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(...`

**Type Parameters:**

- `M extends typeof Model` - The model class.
- `V` - The computed index value type (for function-based indexes).

**Parameters:**

- `MyModel: M` - - The model class to create the index for.
- `fn: (instance: InstanceType<M>) => V[]`

**Returns:** A new SecondaryIndex instance.

**Examples:**

```typescript
class User extends E.Model<User> {
  static byAge = E.index(User, "age");
  static byTagsDate = E.index(User, ["tags", "createdAt"]);
  static byWord = E.index(User, (u: User) => u.name.split(" "));
}
```

### primary · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Create a primary index on model fields.

**Signature:** `{ <M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): PrimaryIndex<M, [F]>; <M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): PrimaryIndex<...>; }`

**Type Parameters:**

- `M extends typeof Model` - The model class.
- `F extends (keyof InstanceType<M> & string)` - The field name (for single field index).

**Parameters:**

- `MyModel: M` - - The model class to create the index for.
- `field: F` - - Single field name for simple indexes.

**Returns:** A new PrimaryIndex instance.

**Examples:**

```typescript
class User extends E.Model<User> {
  static pk = E.primary(User, ["id"]);
  static pkSingle = E.primary(User, "id");
}
```

### unique · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Create a unique index on model fields, or a computed unique index using a function.

For field-based indexes, pass a field name or array of field names.
For computed indexes, pass a function that takes a model instance and returns an array of
index keys. Return `[]` to skip indexing for that instance. Each array element creates a
separate index entry, enabling multi-value indexes (e.g., indexing by each word in a name).

**Signature:** `{ <M extends typeof Model, V>(MyModel: M, fn: (instance: InstanceType<M>) => V[]): UniqueIndex<M, [], [V]>; <M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): UniqueIndex<...>; <M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyMode...`

**Type Parameters:**

- `M extends typeof Model` - The model class.
- `V` - The computed index value type (for function-based indexes).

**Parameters:**

- `MyModel: M` - - The model class to create the index for.
- `fn: (instance: InstanceType<M>) => V[]`

**Returns:** A new UniqueIndex instance.

**Examples:**

```typescript
class User extends E.Model<User> {
  static byEmail = E.unique(User, "email");
  static byNameAge = E.unique(User, ["name", "age"]);
  static byFullName = E.unique(User, (u: User) => [`${u.firstName} ${u.lastName}`]);
}
```

### dump · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Dump database contents for debugging.

Prints all indexes and their data to the console for inspection.
This is primarily useful for development and debugging purposes.

**Signature:** `() => void`

### BaseIndex · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L125)

Base class for database indexes for efficient lookups on model fields.

Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

**Constructor Parameters:**

- `MyModel`: - The model class this index belongs to.
- `_fieldNames`: - Array of field names that make up this index.

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `(opts?: FindOptions<ARGS>) => IndexRangeIterator<M>`

**Parameters:**

- `opts: FindOptions<ARGS>` (optional)

#### baseIndex.batchProcess · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

[object Object],[object Object],[object Object]

**Signature:** `(opts: FindOptions<ARGS> & { limitSeconds?: number; limitRows?: number; }, callback: (row: InstanceType<M>) => void | Promise<void>) => Promise<...>`

**Parameters:**

- `opts: FindOptions<ARGS> & { limitSeconds?: number; limitRows?: number }` (optional) - - Query options (same as `find()`), plus:
- `callback: (row: InstanceType<M>) => void | Promise<void>` - - Called for each matching row within a transaction

#### baseIndex.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

**Signature:** `() => string`

### UniqueIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Unique index that stores references to the primary key.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

#### uniqueIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Get a model instance by unique index key values.

**Signature:** `(...args: ARGS) => InstanceType<M>`

**Parameters:**

- `args: ARGS` - - The unique index key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const userByEmail = User.byEmail.get("john@example.com");
```

### PrimaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Primary index that stores the actual model data.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### primaryIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Get a model instance by primary key values.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - - The primary key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const user = User.pk.get("john_doe");
```

#### primaryIndex.getLazy · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Does the same as as `get()`, but will delay loading the instance from disk until the first
property access. In case it turns out the instance doesn't exist, an error will be thrown
at that time.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - Primary key field values. (Or a single Uint8Array containing the key.)

**Returns:** The (lazily loaded) model instance.

### SecondaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L253)

Secondary index for non-unique lookups.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.
- `ARGS extends readonly any[] = IndexArgTypes<M, F>`

### Change · [type](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L95)

**Type:** `Record<any, any> | "created" | "deleted"`

### Transaction · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L38)

#### transaction.id · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L41)

**Type:** `number`

#### transaction.instances · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L42)

**Type:** `Set<Model<unknown>>`

#### transaction.instancesByPk · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L46)

**Type:** `Map<number, Model<unknown>>`

### DatabaseError · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L157)

The DatabaseError class is used to represent errors that occur during database operations.
It extends the built-in Error class and has a machine readable error code string property.

The lowlevel API will throw DatabaseError instances for all database-related errors.
Invalid function arguments will throw TypeError.

**Value:** `DatabaseErrorConstructor`

### runMigration · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L124)

Run database migration: populate secondary indexes for old-version rows,
convert old primary indices, rewrite row data, and clean up orphaned indices.

**Signature:** `(options?: MigrationOptions) => Promise<MigrationResult>`

**Parameters:**

- `options: MigrationOptions` (optional)

### MigrationOptions · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L16)

#### migrationOptions.tables · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L18)

Limit migration to specific table names.

**Type:** `string[]`

#### migrationOptions.populateSecondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L23)

Populate secondary indexes for rows at old schema versions (default: true).

**Type:** `boolean`

#### migrationOptions.migratePrimaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L32)

Convert old primary indices when primary key fields changed (default: true).

**Type:** `boolean`

#### migrationOptions.rewriteData · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L40)

Rewrite all row data to the latest schema version (default: false).

**Type:** `boolean`

#### migrationOptions.removeOrphans · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L46)

Delete orphaned secondary/unique index entries (default: true).

**Type:** `boolean`

#### migrationOptions.onProgress · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L48)

Progress callback.

**Type:** `(info: ProgressInfo) => void`

### MigrationResult · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L51)

#### migrationResult.secondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L54)

Per-table counts of secondary index entries populated.

**Type:** `Record<string, number>`

#### migrationResult.primaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L59)

Per-table counts of old primary rows migrated.

**Type:** `Record<string, number>`

#### migrationResult.conversionFailures · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L59)

Per-table conversion failure counts by reason.

**Type:** `Record<string, Record<string, number>>`

#### migrationResult.rewritten · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L64)

Per-table counts of rows rewritten to latest version.

**Type:** `Record<string, number>`

#### migrationResult.orphans · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L68)

Number of orphaned index entries deleted.

**Type:** `number`

