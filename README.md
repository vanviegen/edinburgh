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

## TypeScript Configuration

When using TypeScript to transpile to JavaScript, make sure to enable the following options in your `tsconfig.json`:

```json
{
    "compilerOptions": {
        "target": "es2022",
        "experimentalDecorators": true
    }
}
```

## Logging

You can enable debug logging to stdout by setting the `EDINBURGH_LOG_LEVEL` environment variable to a number from 0 to 3. Higher numbers produce more verbose logs, including model-level operations, updates, and reads.

- 0: no logging (default)
- 1: model-level logs
- 2: + update logs
- 3: + read logs

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

### Model · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L218)

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

#### Model.tableName · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L225)

The database table name (defaults to class name).

**Type:** `string`

#### Model.override · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L229)

When true, registerModel replaces an existing model with the same tableName.

**Type:** `boolean`

#### Model.fields · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L230)

Field configuration metadata.

**Type:** `Record<string | number | symbol, FieldConfig<unknown>>`

#### Model.migrate · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

#### Model.findAll · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Find all instances of this model in the database, ordered by primary key.

**Signature:** `<T extends typeof Model<unknown>>(this: T, opts?: { reverse?: boolean; }) => IndexRangeIterator<T>`

**Parameters:**

- `this: T`
- `opts?: {reverse?: boolean}` - - Optional parameters.

**Returns:** An iterator.

#### Model.replaceInto · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Load an existing instance by primary key and update it, or create a new one.

The provided object must contain all primary key fields. If a matching row exists,
the remaining properties from `obj` are set on the loaded instance. Otherwise a
new instance is created with `obj` as its initial properties.

**Signature:** `<T extends typeof Model<any>>(this: T, obj: Partial<Omit<InstanceType<T>, "constructor">>) => InstanceType<T>`

**Parameters:**

- `this: T`
- `obj: Partial<Omit<InstanceType<T>, "constructor">>` - - Partial model data that **must** include every primary key field.

**Returns:** The loaded-and-updated or newly created instance.

#### model.preCommit · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Optional hook called on each modified instance right before the transaction commits.
Runs before data is written to disk, so changes made here are included in the commit.

Common use cases:
- Computing derived or denormalized fields
- Enforcing cross-field validation rules
- Creating or updating related model instances (newly created instances will also
  have their `preCommit()` called)

**Signature:** `() => void`

**Parameters:**


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

#### model.getPrimaryKey · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `() => Uint8Array<ArrayBufferLike>`

**Parameters:**


**Returns:** The primary key for this instance.

#### model.getPrimaryKeyHash · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `() => number`

**Parameters:**


**Returns:** A 53-bit positive integer non-cryptographic hash of the primary key, or undefined if not yet saved.

#### model.isLazyField · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `(field: keyof this) => boolean`

**Parameters:**

- `field: keyof this`

#### model.preventPersist · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Prevent this instance from being persisted to the database.

**Signature:** `() => this`

**Parameters:**


**Returns:** This model instance for chaining.

**Examples:**

```typescript
const user = User.load("user123");
user.name = "New Name";
user.preventPersist(); // Changes won't be saved
```

#### model.delete · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Delete this model instance from the database.

Removes the instance and all its index entries from the database and prevents further persistence.

**Signature:** `() => void`

**Parameters:**


**Examples:**

```typescript
const user = User.load("user123");
user.delete(); // Removes from database
```

#### model.validate · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

#### model.isValid · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Check if this model instance is valid.

**Signature:** `() => boolean`

**Parameters:**


**Returns:** true if all validations pass.

**Examples:**

```typescript
const user = new User({name: "John"});
if (!user.isValid()) shoutAtTheUser();
```

#### model.getState · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `() => "created" | "deleted" | "loaded" | "lazy"`

**Parameters:**


#### model.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `() => string`

**Parameters:**


#### model.[Symbol.for('nodejs.util.inspect.custom')] · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `() => string`

**Parameters:**


### registerModel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L111)

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
class User extends E.Model<User> {
  name = E.field(E.string, {description: "User's full name"});
  age = E.field(E.opt(E.number), {description: "User's age", default: 25});
}
```

### string · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the string type.

**Value:** `TypeWrapper<string>`

### orderedString · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the ordered string type, which is just like a string
except that it sorts lexicographically in the database (instead of by incrementing
length first), making it suitable for index fields that want lexicographic range
scans. Ordered strings are implemented as null-terminated UTF-8 strings, so they
may not contain null characters.

**Value:** `TypeWrapper<string>`

### number · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the number type.

**Value:** `TypeWrapper<number>`

### dateTime · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the date/time type.

**Value:** `TypeWrapper<Date>`

### boolean · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the boolean type.

**Value:** `TypeWrapper<boolean>`

### identifier · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the identifier type.

**Value:** `TypeWrapper<string>`

### undef · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Type wrapper instance for the 'undefined' type.

**Value:** `TypeWrapper<undefined>`

### opt · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

### or · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

### array · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

### literal · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

### link · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

### index · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Create a secondary index on model fields.

**Signature:** `{ <M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): SecondaryIndex<M, [F]>; <M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): SecondaryIndex<...>; }`

**Type Parameters:**

- `M extends typeof Model` - The model class.
- `F extends (keyof InstanceType<M> & string)` - The field name (for single field index).

**Parameters:**

- `MyModel: M` - - The model class to create the index for.
- `field: F` - - Single field name for simple indexes.

**Returns:** A new SecondaryIndex instance.

**Examples:**

```typescript
class User extends E.Model<User> {
  static byAge = E.index(User, "age");
  static byTagsDate = E.index(User, ["tags", "createdAt"]);
}
```

### primary · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

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

### unique · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Create a unique index on model fields.

**Signature:** `{ <M extends typeof Model, const F extends (keyof InstanceType<M> & string)>(MyModel: M, field: F): UniqueIndex<M, [F]>; <M extends typeof Model, const FS extends readonly (keyof InstanceType<M> & string)[]>(MyModel: M, fields: FS): UniqueIndex<...>; }`

**Type Parameters:**

- `M extends typeof Model` - The model class.
- `F extends (keyof InstanceType<M> & string)` - The field name (for single field index).

**Parameters:**

- `MyModel: M` - - The model class to create the index for.
- `field: F` - - Single field name for simple indexes.

**Returns:** A new UniqueIndex instance.

**Examples:**

```typescript
class User extends E.Model<User> {
  static byEmail = E.unique(User, "email");
  static byNameAge = E.unique(User, ["name", "age"]);
}
```

### dump · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Dump database contents for debugging.

Prints all indexes and their data to the console for inspection.
This is primarily useful for development and debugging purposes.

**Signature:** `() => void`

### BaseIndex · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L127)

Base class for database indexes for efficient lookups on model fields.

Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

**Constructor Parameters:**

- `MyModel`: - The model class this index belongs to.
- `_fieldNames`: - Array of field names that make up this index.

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `(opts?: FindOptions<IndexArgTypes<M, F>>) => IndexRangeIterator<M>`

**Parameters:**

- `opts: FindOptions<IndexArgTypes<M, F>>` (optional)

#### baseIndex.batchProcess · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

[object Object],[object Object],[object Object]

**Signature:** `(opts: FindOptions<IndexArgTypes<M, F>> & { limitSeconds?: number; limitRows?: number; }, callback: (row: InstanceType<M>) => void | Promise<...>) => Promise<...>`

**Parameters:**

- `opts: FindOptions<IndexArgTypes<M, F>> & { limitSeconds?: number; limitRows?: number }` (optional) - - Query options (same as `find()`), plus:
- `callback: (row: InstanceType<M>) => void | Promise<void>` - - Called for each matching row within a transaction

#### baseIndex.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

**Signature:** `() => string`

**Parameters:**


### UniqueIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Unique index that stores references to the primary key.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### uniqueIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Get a model instance by unique index key values.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - - The unique index key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const userByEmail = User.byEmail.get("john@example.com");
```

### PrimaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Primary index that stores the actual model data.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### primaryIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Get a model instance by primary key values.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - - The primary key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const user = User.pk.get("john_doe");
```

#### primaryIndex.getLazy · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Does the same as as `get()`, but will delay loading the instance from disk until the first
property access. In case it turns out the instance doesn't exist, an error will be thrown
at that time.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - Primary key field values. (Or a single Uint8Array containing the key.)

**Returns:** The (lazily loaded) model instance.

### SecondaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L251)

Secondary index for non-unique lookups.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

### Change · [type](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L94)

**Type:** `Record<any, any> | "created" | "deleted"`

### Transaction · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L38)

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

### runMigration · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L116)

Run database migration: upgrade all rows to the latest schema version,
convert old primary indices, and clean up orphaned secondary indices.

**Signature:** `(options?: MigrationOptions) => Promise<MigrationResult>`

**Parameters:**

- `options: MigrationOptions` (optional)

### MigrationOptions · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L16)

#### migrationOptions.tables · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L18)

Limit migration to specific table names.

**Type:** `string[]`

#### migrationOptions.convertOldPrimaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L22)

Whether to convert old primary indices for known tables (default: true).

**Type:** `boolean`

#### migrationOptions.deleteOrphanedIndexes · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L30)

Whether to delete orphaned secondary/unique indices (default: true).

**Type:** `boolean`

#### migrationOptions.upgradeVersions · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L38)

Whether to upgrade rows to the latest version (default: true).

**Type:** `boolean`

#### migrationOptions.onProgress · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L42)

Progress callback.

**Type:** `(info: ProgressInfo) => void`

### MigrationResult · [interface](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L47)

#### migrationResult.secondaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L49)

Per-table stats for row upgrades.

**Type:** `Record<string, number>`

#### migrationResult.primaries · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L50)

Per-table stats for old primary conversions.

**Type:** `Record<string, number>`

#### migrationResult.conversionFailures · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L56)

Per-table conversion failure counts by reason.

**Type:** `Record<string, Record<string, number>>`

#### migrationResult.orphaned · [member](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L57)

Number of orphaned index entries deleted.

**Type:** `number`

## Schema Migrations

Edinburgh automatically tracks the schema version of each model. When you change fields, field types, indexes, or the `migrate()` function, Edinburgh detects a new schema version.

### What happens automatically (lazy migration)

Changes to regular (non-index) field values are migrated lazily. When a row with an old schema version is loaded from disk, it is deserialized using the old field types and transformed by the optional static `migrate()` function. This is transparent and requires no downtime.

```typescript
@E.registerModel
class User extends E.Model<User> {
  static pk = E.primary(User, "id");
  id = E.field(E.identifier);
  name = E.field(E.string);
  role = E.field(E.string);  // newly added field

  static migrate(record: Record<string, any>) {
    record.role ??= "user";  // provide a default for old rows
  }
}
```

### What requires `migrate-edinburgh`

The `migrate-edinburgh` CLI tool (or the `runMigration()` API) must be run when:

- **Adding or removing** secondary or unique indexes
- **Changing the fields or types** of an existing index
- A **`migrate()` function changes values** that are used in index fields

The tool populates new indexes, removes orphaned ones, and updates index entries whose values were changed by `migrate()`. It does *not* rewrite primary data rows - lazy migration handles that on read.

```bash
npx migrate-edinburgh --import ./src/models.ts
```

Run `npx migrate-edinburgh` to see all of its options.

You can also call `runMigration()` programmatically:

```typescript
import { runMigration } from "edinburgh";

const result = await runMigration({ tables: ["User"] });
console.log(result.upgraded);  // { User: 1500 }
```
