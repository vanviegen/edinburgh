import { test, expect } from "bun:test";
import * as E from '../src/typing';
import { Bytes } from '../src/bytes';



const Person = E.createModel({
    name: { type: E.string, description: "Full name" },
    age: { type: E.opt(E.number), description: "Current age" },
    cars: { type: E.array(E.opt(E.string)), description: "Owned car types" },
    test: { type: E.or(E.string, E.number), description: "Test field with union type" },
    owned_data: { type: E.array(E.link(() => Data)) }
});


const Data = E.createModel({
    id: { type: E.number, description: "Unique identifier" },
    nothing: {type: E.literal("test"), description: "A useless literal field with a fixed value"},
    mode: { type: E.or("auto", "manual", E.array(E.number)), description: "Operation mode" },
    createdAt: { type: E.number, description: "Creation timestamp" },
    owner: { type: E.opt(E.link(Person)), description: "Optional data owner"},
    subjects: { type: E.array(E.link(Person), {min: 1, max: 10}), description: "The people this data is about"},
});


let p = new Person({name: "x", age: "y"});
p.cars = ["Toyota", "Honda", undefined, "Ford"];
p.owned_data = [new Data({mode: "auto"}), new Data(), 3];
p.owned_data[0].mode = "error";


// , {
//     tableName: "test"
// }) {
//     static nextId = 1;
//     constructor() {
//         super();
//         this.id = Data.nextId++;
//         this.mode = "manual";
//         this.createdAt = Date.now();
//     }
// }

test("Person model serialization and deserialization", () => {
    let model = new Person({test: "hello"});
    model.name = "test";
    model.age = 42;
    model.cars = ["Toyota", "Honda", undefined, "Ford"];
    model.test = 123;

    let bytes = new Bytes();
    model.serialize(bytes);

    expect(bytes).toBeDefined();

    let model2 = Person.deserialize(bytes.copy());

    expect(model2.name).toBe("test");
    expect(model2.age).toBe(42);
    expect(model2.cars).toEqual(["Toyota", "Honda", undefined, "Ford"]);
    expect(model2.test).toBe(123);
    expect(model2.toString()).toBe("test (42 years old)");
});

test("Data model creation and serialization", () => {
    let data = new Data();
    data.mode = "manual";

    expect(data.id).toBeGreaterThan(0);
    expect(data.mode).toBe("manual");
    expect(data.createdAt).toBeGreaterThan(0);

    let dataBytes = new Bytes();
    data.serialize(dataBytes);

    expect(dataBytes).toBeDefined();

    let data2 = Data.deserialize(dataBytes.copy());

    expect(data2.id).toBe(data.id);
    expect(data2.mode).toBe("manual");
    expect(data2.createdAt).toBe(data.createdAt);
});

test("Model metadata serialization and deserialization", () => {
    let metaBytes = new Bytes();
    E.serializeModel(Data, metaBytes);

    expect(metaBytes).toBeDefined();

    const Data2 = E.deserializeModel(metaBytes.copy());

    expect(Data2).toBeDefined();

    // Test that deserialized model can deserialize data
    let data = new Data();
    let dataBytes = new Bytes();
    data.serialize(dataBytes);

    let data3 = Data2.deserialize(dataBytes.copy());

    expect(data3).toBeDefined();
    expect(data3.id).toBe(data.id);
    expect(data3.mode).toBe(data.mode);
});


/*

class Person extends E.createModel({
    name: { type: E.string, description: "Full name" },
    age: { type: E.opt(E.number), description: "Current age" },
    cars: { type: E.array(E.opt(E.string)), description: "Owned car types" },
    test: { type: E.or(E.string, E.number), description: "Test field with union type" },
    password: { type: E.string, description: "Password for authentication", sensitive: true },
}) {
    toString() { return `${this.name} (${this.age} years old)` }
}

class Data extends E.createModel({
    id: { type: E.number, description: "Unique identifier" },
    nothing: {type: E.literal("test"), description: "A useless literal field with a fixed value"},
    mode: { type: E.or("auto", "manual", E.array(E.number)), description: "Operation mode" },
    createdAt: { type: E.number, description: "Creation timestamp" },
}, {
    tableName: "test"
}) {
    static nextId = 1;
    constructor() {
        super();
        this.id = Data.nextId++;
        this.mode = "manual";
        this.createdAt = Date.now();
    }
}

Person.stream({
    password: false,
    friends: {
        name: true
    }
})

## Data storage
- Data is stored in an embedded key/value store (OLMDB).

## Streaming Subsets of Data
- We want to stream a subset of the data to the client, e.g. only friends' names
- Server-side, we have classes including methods. Do we actually need that? Probably not. If we ditch methods, it would be easier to ship subsets of data to the client.
- We can use something like the above to determine which subset is needed. TypeScript should be able to relay type info though.
- We'd also like to tag fields in classes, and then use those tags to determine which fields to send to the client.
- How does the browser cause changes to be made though? It would need to send a request to the server, which then updates the database and notifies the client.
- But that would feel slow, due to the round trip time. How can we make (some) changes feel instant? We'll just use Aberdeen's predictions.

## Secondary indexes
- We can define secondary indexes based on a combination of fields or a computer value.
- They are implemented as key/value pairs, where the key is the index key and the value is the primary key of the data.
- They need to be updated whenever the data changes, within the same transaction.

## Migrations
- The data on disk has a version. For each version, we can validate that it is compatible (doesn't break) with the current schema.
- There's a migrations object, with keys like 1, 2, etc. Each migration is a function that takes the data and returns the migrated data.
- Deployment must be managed by something we provide:
  - It will verify that all data can be migrated (without actually making changes, that will be done on-demand)
  - It will build any new indexes, keeping them up-to-date in the background
  - If everything is done and fine, it will migrate the code
*/
