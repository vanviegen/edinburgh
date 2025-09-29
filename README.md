# Edinburgh
**Very fast object persistence for TypeScript, supporting optimistic transactions, lazy loading and indexes.**

Edinburgh is a high-performance ORM built on [OLMDB](https://github.com/vanviegen/olmdb), providing type-safe model definitions with automatic field validation, ACID transactions, and efficient LMDB-based storage.

**Features:**

- 🚀 **Type-Safe Models**: Define models with automatic TypeScript type inference and runtime validation
- 🔒 **ACID Transactions**: Optimistic locking with automatic retry on conflicts  
- 🔗 **Relationships**: Model instances can reference each other, and will be lazy-loaded on access
- 📦 **Embedded Database**: Negligible query latency, due to a blazing fast embedded database (LMDB)
- 📊 **Custom Indexing**: Efficient querying with primary, unique, and multi-value indexes

## Quick Demo
```typescript
import * as E from "edinburgh";

// Initialize the database (optional, defaults to "./.olmdb")
E.init("./my-database");

// Define a model
@E.registerModel
class User extends E.Model<User> {
  // Define a primary key (optional, defaults to using the "id" field)
  static pk = E.index(User, ["id"], "primary");
  // Define a unique index on the email field
  static byEmail = E.index(User, "email", "unique");

  // Define fields with simple types -- they will be type-checked at compile time and validated at runtime.
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
  age = E.field(E.opt(E.number));

  // A field with a more elaborate type. In Typescript: `User | User[] | "self" | "spouse"`
  supervisor = E.field(E.choice(E.link(User), E.array(E.link(User)), E.literal("self"), E.literal("spouse")));
}

// Use in transactions
await E.transact(() => {
  const user = new User({
    name: "John Doe", 
    email: "john@example.com"
  });
});

await E.transact(() => {
  // Query by unique index
  const user = User.byEmail.get("john@example.com")!;
  // The transaction will retry if there's a conflict, such as another transaction
  // modifying the same user (from another async function or another process)
  user.age++;
});
```

## API Reference

The following is auto-generated from `src/edinburgh.ts`:

### transact · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L89)

Executes a function within a database transaction context.

Loading models (also through links in other models) and changing models can only be done from
within a transaction.

Transactions have a consistent view of the database, and changes made within a transaction are
isolated from other transactions until they are committed. In case a commit clashes with changes
made by another transaction, the transaction function will automatically be re-executed up to 10
times.

**Signature:** `<T>(fn: () => T) => Promise<T>`

**Type Parameters:**

- `T` - The return type of the transaction function.

**Parameters:**

- `fn: () => T` - - The function to execute within the transaction context.

**Returns:** A promise that resolves with the function's return value.

**Throws:**

- If nested transactions are attempted.
- With code "RACING_TRANSACTION" if the transaction fails after retries due to conflicts.
- With code "TRANSACTION_FAILED" if the transaction fails for other reasons.
- With code "TXN_LIMIT" if maximum number of transactions is reached.
- With code "LMDB-{code}" for LMDB-specific errors.

**Examples:**

```typescript
const paid = await E.transact(() => {
  const user = User.pk.get("john_doe");
  // This is concurrency-safe - the function will rerun if it is raced by another transaction
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
  const counter = Counter.load("global") || new Counter({id: "global", value: 0});
  counter.value++;
});
```

### setOnSaveCallback · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L146)

Set a callback function to be called after a model is saved and committed.

**Signature:** `(callback: (commitId: number, items: ChangedModel[]) => void) => void`

**Parameters:**

- `callback: ((commitId: number, items: ChangedModel[]) => void) | undefined` - [object Object],[object Object],[object Object]

### deleteEverything · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L151)

**Signature:** `() => Promise<void>`

### Model · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Base class for all database models in the Edinburgh ORM.

Models represent database entities with typed fields, automatic serialization,
change tracking, and relationship management. All model classes should extend
this base class and be decorated with `@registerModel`.

**Type Parameters:**

- `SUB` - The concrete model subclass (for proper typing).

**Examples:**

```typescript
⁣@E.registerModel
class User extends E.Model<User> {
  static pk = E.index(User, ["id"], "primary");
  
  id = E.field(E.identifier);
  name = E.field(E.string);
  email = E.field(E.string);
  
  static byEmail = E.index(User, "email", "unique");
}
```

#### Model.tableName · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

The database table name (defaults to class name).

**Type:** `string`

#### Model.fields · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Field configuration metadata.

**Type:** `Record<string | number | symbol, FieldConfig<unknown>>`

#### Model.findAll · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Find all instances of this model in the database, ordered by primary key.

**Signature:** `<T extends typeof Model<unknown>>(this: T, opts?: { reverse?: boolean; }) => IndexRangeIterator<T>`

**Parameters:**

- `this: T`
- `opts?: {reverse?: boolean}` - - Optional parameters.

**Returns:** An iterator.

#### model.changed · [property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

This property can be used in `setOnSave` callbacks to determine how a model instance has changed.
If the value is undefined, the instance has been created. If it's "deleted" the instance has
been deleted. If its an object, the instance has been modified and the object contains the old values.

Note: this property should **not** be accessed *during* a `transact()` -- it's state is an implementation
detail that may change semantics at any minor release.

**Type:** `Record<any, any> | "deleted" | "created"`

#### model.getPrimaryKey · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

**Signature:** `() => Uint8Array<ArrayBufferLike>`

**Parameters:**


**Returns:** The primary key for this instance, or undefined if not yet saved.

#### model.isLazyField · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

**Signature:** `(field: keyof this) => boolean`

**Parameters:**

- `field: keyof this`

#### model.preventPersist · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

#### model.delete · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Delete this model instance from the database.

Removes the instance and all its index entries from the database and prevents further persistence.

**Signature:** `() => void`

**Parameters:**


**Examples:**

```typescript
const user = User.load("user123");
user.delete(); // Removes from database
```

#### model.validate · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

#### model.isValid · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Check if this model instance is valid.

**Signature:** `() => boolean`

**Parameters:**


**Returns:** true if all validations pass.

**Examples:**

```typescript
const user = new User({name: "John"});
if (!user.isValid()) shoutAtTheUser();
```

### registerModel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L91)

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

### field · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L60)

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

### string · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the string type.

**Value:** `TypeWrapper<string>`

### orderedString · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the ordered string type, which is just like a string
except that it sorts lexicographically in the database (instead of by incrementing
length first), making it suitable for index fields that want lexicographic range
scans. Ordered strings are implemented as null-terminated UTF-8 strings, so they
may not contain null characters.

**Value:** `TypeWrapper<string>`

### number · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the number type.

**Value:** `TypeWrapper<number>`

### dateTime · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the date/time type.

**Value:** `TypeWrapper<Date>`

### boolean · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the boolean type.

**Value:** `TypeWrapper<boolean>`

### identifier · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the identifier type.

**Value:** `TypeWrapper<string>`

### undef · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Type wrapper instance for the 'undefined' type.

**Value:** `TypeWrapper<undefined>`

### opt · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### or · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### array · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### literal · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### link · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### index · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### primary · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### unique · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

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

### dump · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Dump database contents for debugging.

Prints all indexes and their data to the console for inspection.
This is primarily useful for development and debugging purposes.

**Signature:** `() => void`

### setLogLevel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L55)

Global log level for debugging output.
0 = no logging, 1 = model-level logs, 2 = update logs, 3 = read logs.

**Signature:** `(level: number) => void`

**Parameters:**

- `level: number`

### BaseIndex · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L129)

Base class for database indexes for efficient lookups on model fields.

Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

**Constructor Parameters:**

- `MyModel`: - The model class this index belongs to.
- `_fieldNames`: - Array of field names that make up this index.

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Find model instances using flexible range query options.

Supports exact matches, inclusive/exclusive range queries, and reverse iteration.
For single-field indexes, you can pass values directly or in arrays.
For multi-field indexes, pass arrays or partial arrays for prefix matching.

**Signature:** `(opts?: FindOptions<IndexArgTypes<M, F>>) => IndexRangeIterator<M>`

**Parameters:**

- `opts: FindOptions<IndexArgTypes<M, F>>` (optional) - - Query options object

**Returns:** An iterable of model instances matching the query

**Examples:**

```typescript
// Exact match
for (const user of User.byEmail.find({is: "john@example.com"})) {
  console.log(user.name);
}

// Range query (inclusive)
for (const user of User.byEmail.find({from: "a@", to: "m@"})) {
  console.log(user.email);
}

// Range query (exclusive)
for (const user of User.byEmail.find({after: "a@", before: "m@"})) {
  console.log(user.email);
}

// Open-ended ranges
for (const user of User.byEmail.find({from: "m@"})) { // m@ and later
  console.log(user.email);
}

for (const user of User.byEmail.find({to: "m@"})) { // up to and including m@
  console.log(user.email);
}

// Reverse iteration
for (const user of User.byEmail.find({reverse: true})) {
  console.log(user.email); // Z to A order
}

// Multi-field index prefix matching
for (const item of CompositeModel.pk.find({from: ["electronics", "phones"]})) {
  console.log(item.name); // All electronics/phones items
}

// For single-field indexes, you can use the value directly
for (const user of User.byEmail.find({is: "john@example.com"})) {
  console.log(user.name);
}
```

#### baseIndex.toString · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

**Signature:** `() => string`

**Parameters:**


### UniqueIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Unique index that stores references to the primary key.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### uniqueIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Get a model instance by unique index key values.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - - The unique index key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const userByEmail = User.byEmail.get("john@example.com");
```

### PrimaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Primary index that stores the actual model data.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### primaryIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Get a model instance by primary key values.

**Signature:** `(...args: IndexArgTypes<M, F> | [Uint8Array<ArrayBufferLike>]) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F> | [Uint8Array]` - - The primary key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const user = User.pk.get("john_doe");
```

#### primaryIndex.getLazy · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Does the same as as `get()`, but will delay loading the instance from disk until the first
property access. In case it turns out the instance doesn't exist, an error will be thrown
at that time.

**Signature:** `(...args: IndexArgTypes<M, F> | [Uint8Array<ArrayBufferLike>]) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F> | [Uint8Array]` - Primary key field values. (Or a single Uint8Array containing the key.)

**Returns:** The (lazily loaded) model instance.

### init · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L141)

Initialize the database with the specified directory path.
This function may only be called once. If it is not called before the first transact(),
the database will be automatically initialized with the default directory.

**Signature:** `(dbDir?: string) => void`

**Parameters:**

- `dbDir?: string` - - Optional directory path for the database (defaults to environment variable $OLMDB_DIR or "./.olmdb").

**Throws:**

- With code "DUP_INIT" if database is already initialized.
- With code "CREATE_DIR_FAILED" if directory creation fails.
- With code "LMDB-{code}" for LMDB-specific errors.

**Examples:**

```typescript
init("./my-database");
```

### onCommit · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L159)

Registers a callback to be executed when the current transaction commits successfully.
The callback will be executed outside of transaction context.

**Signature:** `(callback: (commitSeq: number) => void) => void`

**Parameters:**

- `callback: (commitSeq: number) => void` - - Function to execute when transaction commits. It receives the commit sequence, which is an always-increasing number that provides a global ordering of commits, as an argument.

**Throws:**

- If called outside of a transaction context

### onRevert · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L151)

Registers a callback to be executed when the current transaction is reverted (aborted due to error).
The callback will be executed outside of transaction context.

**Signature:** `(callback: (commitSeq: number) => void) => void`

**Parameters:**

- `callback: (commitSeq: number) => void` - - Function to execute when transaction is reverted. It receives the dummy (always 0) commit sequence indicating failure as an argument.

**Throws:**

- If called outside of a transaction context

### getTransactionData · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L55)

Retrieves data from the current transaction context.

**Signature:** `(key: symbol) => any`

**Parameters:**

- `key: symbol` - - A symbol key to retrieve data from the current transaction context.

**Returns:** - The value associated with the key, or undefined if not set.

**Throws:**

- If called outside of a transaction context.

### setTransactionData · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L46)

Attach some arbitrary user data to the current transaction context, which is
attached to the currently running (async) task.

**Signature:** `(key: symbol, value: any) => void`

**Parameters:**

- `key: symbol` - - A symbol key to store data in the current transaction context.
- `value: any` - - The value to store.

**Throws:**

- If called outside of a transaction context.

**Examples:**

```typescript
const MY_SYMBOL = Symbol("myKey");
await transact(async () => {
  setTransactionData(MY_SYMBOL, "myValue");
  await somethingAsync(); // Can be interleaved with other transactions
  const value = getTransactionData(MY_SYMBOL);
  console.log(value); // "myValue"
});
```

### DatabaseError · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L142)

The DatabaseError class is used to represent errors that occur during database operations.
It extends the built-in Error class and has a machine readable error code string property.

The lowlevel API will throw DatabaseError instances for all database-related errors.
Invalid function arguments will throw TypeError.

**Value:** `DatabaseErrorConstructor`

