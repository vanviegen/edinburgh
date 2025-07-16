import { test, expect, beforeEach } from "bun:test";
import * as E from '../src/typing';
const {field} = E;


try {
    E.olmdb.init("./.olmdb_test");
} catch (error: any) {
    if (error.code !== "DUP_INIT") {
        throw error; // Rethrow if it's not the expected error
    }
}

@E.registerModel
class Person extends E.Model<Person> {
    name = field(E.string, {description: "Full name", primary: true});
    age = field(E.opt(E.number), {description: "Current age", default: 42});
    cars = field(E.array(E.opt(E.string)), {description: "Owned car types"});
    test = field(E.or(E.string, E.number), {description: "Test field with union type", default: "example"});
    owned_data = field(E.array(E.link(Data)), {description: "Owned data", default: () => []});

    static byName = E.index(Person, ["name","test"], "unique");
    static byCar = E.index(Person, ["cars"]);
}

Person.byName.get("Frank", "test");
Person.byName.get(42, "test");
Person.byName.get("Frank", 42);

Person.byCar.get(["Toyota", "Honda"]);
Person.byCar.get([true, "Honda"]);


@E.registerModel
class Data extends E.Model<Data> {
    id = field(E.number, {description: "Unique identifier", primary: true});
    nothing = field(E.literal("test"), {description:  "A useless literal field with a fixed value", default: "test"});
    mode = field(E.or("auto", "manual", E.array(E.number)), {description: "Operation mode", default: "auto"});
    createdAt = field(E.number, {description: "Creation timestamp"});
    owner = field(E.opt(E.link(Person)), {description: "Optional data owner"});
    subjects = field(E.array(E.link(Person), {min: 1, max: 10}),{description:  "The people this data is about"});

    // static byCreationTime = E.index("createdAt");
    // static bySubject = E.index("subjects", {multi: true});
}

function noNeedToRunThis() {
    // Verify that TypeScript errors pop up in all the right places and not in the wrong places.
    // @ts-expect-error
    let z = new Person({name: "x", age: "Str"});

    let p = new Person({name: "x", age: 42});
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

beforeEach(async () => {
    // Clean up all existing pairs
    await E.transact(() => {
        for (const {key} of E.olmdb.scan()) {
            E.olmdb.del(key);
        }
    });
});

test("Checks for validity", () => {
    let p = new Person({cars: ["Toyota", "Honda", "Ford"]});
    expect(p.isValid()).toBe(false);

    p.name = "Frank";
    expect(p.isValid()).toBe(true);

    p.age = undefined;
    expect(p.isValid()).toBe(true);

    // @ts-expect-error
    p.cars = undefined;
    expect(p.isValid()).toBe(false);

    // @ts-expect-error
    p.cars = 3;
    // p.cars = ["Toyota", "Honda", undefined, "Ford", 5];
    expect(p.isValid()).toBe(false);
    p.cars = ["Toyota", "Honda", "Ford"];
    expect(p.isValid()).toBe(true);

    // @ts-expect-error
    p.age = "y";
    expect(p.isValid()).toBe(false);
    p.age = 42;
    expect(p.isValid()).toBe(true);
})

test("Sets defaults", () => {

    @E.registerModel
    class Defaults extends E.Model<Defaults> {
        // @ts-expect-error
        first = field(E.string, {default: 3});
        // @ts-expect-error
        last = field(E.string, {default: () => 3});
        role = field(E.string, {default: () => "CEO"});
        tags = field(E.array(E.number), {default: () => [12, 5]})
        userName = field(E.string, {default: obj => `${obj.first}${obj.last[0]||''}`.toLowerCase()})
    }

    let d = new Defaults();
    expect(d.role).toBe("CEO");
    expect(d.tags).toEqual([12, 5]);
    d.tags.pop()
    d.first = "John";
    d.last = "Lennon";
    expect(d.userName).toBe("johnl");

    let e = new Defaults();
    e.tags.push(9);

    expect(d.tags).toEqual([12]);
    expect(e.tags).toEqual([12, 5, 9]);
})

test("Boolean type validation", () => {
    @E.registerModel
    class Settings extends E.Model<Settings> {
        enabled = field(E.boolean, {description: "Feature toggle"});
    }

    let s = new Settings({enabled: true});
    expect(s.isValid()).toBe(true);

    // @ts-expect-error
    s.enabled = "true";
    expect(s.isValid()).toBe(false);

    s.enabled = false;
    expect(s.isValid()).toBe(true);
})

test("Model persistence", async () => {
    @E.registerModel
    class TestModel extends E.Model<TestModel> {
        id = field(E.number, {primary: true});
        name = field(E.string);
        flag = field(E.boolean, {default: false});
    }

    await E.transact(async () => {
        const model = new TestModel({id: 1, name: "test"});
        model.save();
    });

    await E.transact(() => {
        const loaded = TestModel.load(1);
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("test");
        expect(loaded!.flag).toBe(false);
    });

    // Test loading non-existent model
    const notFound = await E.transact(() => TestModel.load(999));
    expect(notFound).toBeUndefined();

    // Test loading with wrong number of primary keys
    expect(() => TestModel.load(1, 2)).toThrow();
})

test("Link type validation and lazy loading", async () => {
    await E.transact(async () => {
        let person = new Person({name: "Frank", cars: ["Toyota", "Honda"]});
        person.save();

        let data = new Data({
            id: 1,
            mode: "auto",
            createdAt: 123456,
            subjects: [person]
        });
        data.save();
    });

    // Test loading
    await E.transact(async () => {
        const loadedData = await Data.load(1)
        expect(loadedData).toBeDefined();
        expect(loadedData!.id).toBe(1);
        expect(loadedData!.mode).toBe("auto");
        expect(loadedData!.createdAt).toBe(123456);
        expect(loadedData!.subjects.length).toBe(1);
        expect(loadedData!.subjects[0].name).toBe("Frank");

        // @ts-expect-error
        loadedData!.subjects = [new Data()];
        expect(loadedData!.isValid()).toBe(false);
    });
})

