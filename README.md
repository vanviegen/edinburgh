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
