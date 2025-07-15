import { test, expect } from "bun:test";
import * as E from '../src/typing';
const {field, Model} = E;
import { Bytes } from '../src/bytes';

class Person extends Model {
    name = field(E.string, {description: "Full name"});
    age = field(E.opt(E.number), {description: "Current age"});
    cars = field(E.array(E.opt(E.string)), {description: "Owned car types"});
    test = field(E.or(E.string, E.number), {description: "Test field with union type"});
    owned_data = field(E.array(E.link(() => Data)), {description: "Owned data"});
}

class Data extends Model {
    static tableName = "test"; // Override table name for serialization

    id = field(E.number, {description: "Unique identifier"});
    nothing = field(E.literal("test"), {description:  "A useless literal field with a fixed value"});
    mode = field(E.or("auto", "manual", E.array(E.number)), {description: "Operation mode"});
    createdAt = field(E.number, {description: "Creation timestamp"});
    owner = field(E.opt(E.link(Person)), {description: "Optional data owner"});
    subjects = field(E.array(E.link(Person), {min: 1, max: 10}),{description:  "The people this data is about"});
}

// Register models (could be moved to automatic registration process)
// E.registerModel(Person);
// E.registerModel(Data);


let p = new Person({name: "x", age: "y"});
p.age = "y"; // error
p.cars = ["Toyota", "Honda", undefined, "Ford"];
p.owned_data = [new Data({mode: "auto"}), new Data(), 3];
p.owned_data[0].mode = "error"; // error
p.owned_data[0].createdAt = 3;

if (p.owned_data[0].owner) p.owned_data[0].owner.name = "Frank";
if (p.owned_data[0].owner) p.owned_data[0].owner.name = 42; // error
