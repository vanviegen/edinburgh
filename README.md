# Edinburgh
**Very fast object persistence for TypeScript, supporting optimistic transactions, on-demand reference loading, automatic back-references and indexes.**

Edinburgh is a high-performance ORM built on [OLMDB](https://github.com/vanviegen/olmdb), providing type-safe model definitions with automatic field validation, ACID transactions, and efficient LMDB-based storage.

**Features:**

- 🚀 **Type-Safe Models**: Define models with automatic TypeScript type inference and runtime validation
- 🔒 **ACID Transactions**: Optimistic locking with automatic retry on conflicts  
- 🔗 **Relationship Management**: Automatic back-references and link handling between models
- 📊 **Custom Indexing**: Efficient querying with primary, unique, and multi-value indexes
- 📦 **Zero Dependencies**: Minimal footprint, built on LMDB for maximum performance

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

### transact · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L83)

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
  const user = User.load("john_doe");
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

### deleteEverything · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L112)

**Signature:** `() => Promise<void>`

### Model · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

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

#### Model.tableName · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

The database table name (defaults to class name).

**Type:** `string`

#### Model.fields · [static property](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Field configuration metadata.

**Type:** `Record<string, FieldConfig<unknown>>`

#### Model.load · [static method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Load a model instance by primary key.

**Signature:** `<SUB>(this: typeof Model<SUB>, ...args: any[]) => SUB`

**Parameters:**

- `this: typeof Model<SUB>`
- `args: any[]` - - Primary key field values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const user = User.load("user123");
const post = Post.load("post456", "en");
```

#### model.preventPersist · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Prevent this instance from being persisted to the database.

Removes the instance from the modified instances set and disables
automatic persistence at transaction commit.

**Signature:** `() => this`

**Parameters:**


**Returns:** This model instance for chaining.

**Examples:**

```typescript
const user = User.load("user123");
user.name = "New Name";
user.preventPersist(); // Changes won't be saved
```

#### model.delete · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Delete this model instance from the database.

Removes the instance and all its index entries from the database and prevents further persistence.

**Signature:** `() => void`

**Parameters:**


**Examples:**

```typescript
const user = User.load("user123");
user.delete(); // Removes from database
```

#### model.validate · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Validate all fields in this model instance.

**Signature:** `(raise?: boolean) => DatabaseError[]`

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

#### model.isValid · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Check if this model instance is valid.

**Signature:** `() => boolean`

**Parameters:**


**Returns:** true if all validations pass.

**Examples:**

```typescript
const user = new User({name: "John"});
if (!user.isValid()) shoutAtTheUser();
```

### registerModel · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Register a model class with the Edinburgh ORM system.

This decorator function transforms the model class to use a proxy-based constructor
that enables change tracking and automatic field initialization. It also extracts
field metadata and sets up default values on the prototype.

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

### field · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L55)

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

### setOnSaveCallback · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L85)

Set a callback function to be called after a model is saved and committed.

**Signature:** `(callback: OnSaveType) => void`

**Parameters:**

- `callback: OnSaveType | undefined` - The callback function to set. As arguments, it receives the model instance, the new key (undefined in case of a delete), and the old key (undefined in case of a create).

### string · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Constant representing the string type.

**Value:** `StringType`

### number · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Constant representing the number type.

**Value:** `NumberType`

### boolean · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Constant representing the boolean type.

**Value:** `BooleanType`

### identifier · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Constant representing the identifier type.

**Value:** `IdentifierType`

### undef · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Constant representing the 'undefined' type.

**Value:** `LiteralType<any>`

### opt · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Create an optional type wrapper (allows undefined).

**Signature:** `<const T extends TypeWrapper<unknown> | BasicType>(inner: T) => OrType<any>`

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

### or · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Create a union type wrapper from multiple type choices.

**Signature:** `<const T extends (TypeWrapper<unknown> | BasicType)[]>(...choices: T) => OrType<UnwrapTypes<T>>`

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

### array · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Create an array type wrapper with optional length constraints.

**Signature:** `<const T>(inner: TypeWrapper<T>, opts?: { min?: number; max?: number; }) => ArrayType<T>`

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

### literal · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Create a literal type wrapper for a constant value.

**Signature:** `<const T>(value: T) => LiteralType<T>`

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

### link · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Create a link type wrapper for model relationships.

**Signature:** `<const T extends typeof Model<any>>(TargetModel: T) => LinkType<T>`

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

### index · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

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

### primary · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

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

### unique · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

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

### dump · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Dump database contents for debugging.

Prints all indexes and their data to the console for inspection.
This is primarily useful for development and debugging purposes.

**Signature:** `() => void`

### BaseIndex · [abstract class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L104)

Base class for database indexes for efficient lookups on model fields.

Indexes enable fast queries on specific field combinations and enforce uniqueness constraints.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

**Constructor Parameters:**

- `MyModel`: - The model class this index belongs to.
- `_fieldNames`: - Array of field names that make up this index.

#### baseIndex.find · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Find model instances using flexible range query options.

Supports exact matches, inclusive/exclusive range queries, and reverse iteration.
For single-field indexes, you can pass values directly or in arrays.
For multi-field indexes, pass arrays or partial arrays for prefix matching.

**Signature:** `(opts?: FindOptions<IndexArgTypes<M, F>>) => IndexRangeIterator<M, F>`

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

### UniqueIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Unique index that stores references to the primary key.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### uniqueIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Get a model instance by unique index key values.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - - The unique index key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const userByEmail = User.byEmail.get("john@example.com");
```

### PrimaryIndex · [class](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Primary index that stores the actual model data.

**Type Parameters:**

- `M extends typeof Model` - The model class this index belongs to.
- `F extends readonly (keyof InstanceType<M> & string)[]` - The field names that make up this index.

#### primaryIndex.get · [method](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Get a model instance by primary key values.

**Signature:** `(...args: IndexArgTypes<M, F>) => InstanceType<M>`

**Parameters:**

- `args: IndexArgTypes<M, F>` - - The primary key values.

**Returns:** The model instance if found, undefined otherwise.

**Examples:**

```typescript
const user = User.pk.get("john_doe");
```

### init · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

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

### onCommit · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Registers a callback to be executed when the current transaction commits successfully.
The callback will be executed outside of transaction context.

**Signature:** `(callback: (commitSeq: number) => void) => void`

**Parameters:**

- `callback: (commitSeq: number) => void` - - Function to execute when transaction commits. It receives the commit sequence, which is an always-increasing number that provides a global ordering of commits, as an argument.

**Throws:**

- If called outside of a transaction context

### onRevert · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

Registers a callback to be executed when the current transaction is reverted (aborted due to error).
The callback will be executed outside of transaction context.

**Signature:** `(callback: (commitSeq: number) => void) => void`

**Parameters:**

- `callback: (commitSeq: number) => void` - - Function to execute when transaction is reverted. It receives the dummy (always 0) commit sequence indicating failure as an argument.

**Throws:**

- If called outside of a transaction context

### getTransactionData · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L51)

Retrieves data from the current transaction context.

**Signature:** `(key: symbol) => any`

**Parameters:**

- `key: symbol` - - A symbol key to retrieve data from the current transaction context.

**Returns:** - The value associated with the key, or undefined if not set.

**Throws:**

- If called outside of a transaction context.

### setTransactionData · [function](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L44)

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

### DatabaseError · [constant](https://github.com/vanviegen/edinburgh/blob/main/src/edinburgh.ts#L120)

The DatabaseError class is used to represent errors that occur during database operations.
It extends the built-in Error class and has a machine readable error code string property.

The lowlevel API will throw DatabaseError instances for all database-related errors.
Invalid function arguments will throw TypeError.

**Value:** `DatabaseErrorConstructor`

