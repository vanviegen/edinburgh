import { test, expect } from "bun:test";
import * as E from '../src/typing';
const {field, Model} = E;

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

function noNeedToRunThis() {
    // Verify that TypeScript errors pop up in all the right places and not in the wrong places.

    let p = new Person({name: "x", age: 42});
    // @ts-expect-error
    let z = new Person({name: "x", age: "Str"});
    p.age = 42;
    // @ts-expect-error
    p.age = "y"; // error: string is not assignable to number
    // @ts-expect-error
    p.cars = ["Toyota", "Honda", undefined, "Ford", 5]; // error: number is not assignable to string
    p.owned_data = [new Data({mode: "auto"}), new Data()];
    // @ts-expect-error
    p.owned_data = [new Data({mode: "auto"}), new Data(), 3]; // error: number is not assignable to string
    // @ts-expect-error
    p.owned_data = undefined; // error: undefined is not assignable to Data[]
    p.owned_data = [];
    // @ts-expect-error
    p.owned_data[0].mode = "wrong"; // error: "wrong" is not assignable to "auto" | "manual" | number[]
    p.owned_data[0].mode = "manual";
    p.owned_data[0].createdAt = 3;

    // TODO: Hmm, why is TypeScript not complaining about owner_data[0] being possibly undefined?

    if (p.owned_data[0].owner) p.owned_data[0].owner.name = "Frank";
    // @ts-expect-error
    if (p.owned_data[0].owner) p.owned_data[0].owner.name = 42; // error: number is not assignable to string
    // @ts-expect-error
    p.owned_data[0].subjects[0].owned_data[0].createdAt = "x"; // error: string is not assignable to number
    p.owned_data[0].subjects[0].owned_data[0].createdAt = 123;
}

test("Initialization", () => {
    let p = new Person({name: "x", age: 42, cars: ["Toyota", "Honda", "Ford"]});
    expect(p.isValid()).toBe(true);
    p.age = undefined;
    expect(p.isValid()).toBe(true);
    p.age = "y";
    expect(p.isValid()).toBe(false);
    p.age = 42;
    expect(p.isValid()).toBe(true);
    p.cars = ["Toyota", "Honda", undefined, "Ford", 5];
    expect(p.isValid()).toBe(false);
    p.cars = ["Toyota", "Honda", "Ford"];
    expect(p.isValid()).toBe(true);
}