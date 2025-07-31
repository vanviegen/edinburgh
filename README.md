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
import { Model, registerModel, field, string, number, index, transact, init } from "edinburgh";

// Initialize the database (optional, defaults to "./.olmdb")
init("./my-database");

// Define a model
@registerModel
class User extends Model<User> {
  // Define a primary key (optional, defaults to using the "id" field)
  static pk = index(User, ["id"], "primary");
  // Define a unique index on the email field
  static byEmail = index(User, "email", "unique");

  // Define fields with simple types -- they will be type-checked at compile time and validated at runtime.
  id = field(identifier);
  name = field(string);
  email = field(string);
  age = field(opt(number));

  // A field with a more elaborate type. In Typescript: `User | User[] | "self" | "spouse"`
  supervisor = field(choice(link(User), array(link(User)), literal("self"), literal("spouse")));
}

// Use in transactions
await transact(() => {
  const user = new User({
    name: "John Doe", 
    email: "john@example.com"
  });
});

await transact(() => {
  // Query by unique index
  const user = User.byEmail.get("john@example.com")!;
  // The transaction will retry if there's a conflict, such as another transaction
  // modifying the same user (from another async function or another process)
  user.age++;
});
```

## API Reference

The following is auto-generated from `src/edinburgh.ts`:
### transact

Executes a function within a database transaction context.

Loading models (also through links in other models) and changing models can only be done from
within a transaction.

Transactions have a consistent view of the database, and changes made within a transaction are
isolated from other transactions until they are committed. In case a commit clashes with changes
made by another transaction, the transaction function will automatically be re-executed up to 10
times.

| Function | Type |
| ---------- | ---------- |
| `transact` | `<T>(fn: () => T) => Promise<T>` |

Parameters:

* `fn`: - The function to execute within the transaction context


Returns:

A promise that resolves with the function's return value

Examples:

```typescript
const result = await transact(() => {
  const user = User.load("john_doe");
  user.credits--;
  return user.credits;
});
```
```typescript
// Transaction with automatic retry on conflicts
await transact(() => {
  const counter = Counter.load("global") || new Counter({id: "global", value: 0});
  counter.value++;
});
```