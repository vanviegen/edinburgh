import { test, expect, beforeEach } from "vitest";
import * as E from '../src/edinburgh.js';
import { Change } from "../src/models.js";

try {
    E.init("./.edinburgh_test");
} catch (error: any) {
    if (error.code !== "DUP_INIT") {
        throw error; // Rethrow if it's not the expected error
    }
}

// Helper to assert that a function throws a DatabaseError with a specific code
function expectErrorCode(code: string, fn: () => any) {
    let result: any;
    try {
        result = fn();
    } catch (e: any) {
        expect(e).toMatchObject({ code });
        return;
    }
    return expect(Promise.resolve(result)).rejects.toMatchObject({ code });
}

@E.registerModel
class Person extends E.Model<Person> {
    static pk = E.primary(Person, ["name"]);

    name = E.field(E.string, {description: "Full name"});
    age = E.field(E.opt(E.number), {description: "Current age", default: 42});
    cars = E.field(E.array(E.opt(E.string)), {description: "Owned car types"});
    test = E.field(E.or(E.string, E.number), {description: "Test field with union type", default: "example"});
    ownedData = E.field(E.array(E.link(Data)), {description: "Owned data", default: () => []});

    static byCombi = E.unique(Person, ["name","test"]);
    static byCar = E.unique(Person, ["cars"]);
}

@E.registerModel
class Simple extends E.Model<Simple> {
    id = E.field(E.identifier, {description: "Unique identifier"});
    value = E.field(E.number, {description: "Some number"});
    name = E.field(E.string, {description: "A name", default: "unknown"});
    
    static pk = E.primary(Simple, ["id"]);
    static byValue = E.unique(Simple, ["value"]);
}


@E.registerModel
class Data extends E.Model<Data> {
    id = E.field(E.identifier, {description: "Unique identifier"});
    nothing = E.field(E.literal("test"), {description:  "A useless literal field with a fixed value", default: "test"});
    mode = E.field(E.or("auto", "manual", E.array(E.number)), {description: "Operation mode", default: "auto"});
    createdAt = E.field(E.number, {description: "Creation timestamp"});
    owner = E.field(E.opt(E.link(Person)), {description: "Optional data owner"});
    subjects = E.field(E.array(E.link(Person), {min: 1, max: 10}), {description:  "The people this data is about"});

    // static byCreationTime = E.index(Data, "createdAt");
    // static bySubject = E.index("subjects", {multi: true});
}

// Additional models for comprehensive testing
@E.registerModel
class User extends E.Model<User> {
    static pk = E.primary(User, ["id"]);
    
    id = E.field(E.identifier, {description: "User ID"});
    email = E.field(E.string, {description: "User email"});
    name = E.field(E.string, {description: "Display name"});
    isActive = E.field(E.boolean, {description: "Account status", default: true});
    posts = E.field(E.array(E.link(Post)), {description: "User's posts", default: () => []});
    
    static byEmail = E.unique(User, "email");
}

@E.registerModel
class CompositeKeyModel extends E.Model<CompositeKeyModel> {
    static pk = E.primary(CompositeKeyModel, ["category", "subcategory", "name"]);
    
    category = E.field(E.orderedString, {description: "Main category"});
    subcategory = E.field(E.orderedString, {description: "Sub category"});
    name = E.field(E.orderedString, {description: "Item name"});
    value = E.field(E.number, {description: "Item value"});
    
    static byValue = E.unique(CompositeKeyModel, ["value"]);
}

@E.registerModel
class Post extends E.Model<Post> {
    static pk = E.primary(Post, ["id"]);
    
    id = E.field(E.identifier, {description: "Post ID"});
    title = E.field(E.string, {description: "Post title"});
    content = E.field(E.string, {description: "Post content"});
    author = E.field(E.link(User), {description: "Post author"});
    tags = E.field(E.array(E.string), {description: "Post tags", default: () => []});
    publishedAt = E.field(E.opt(E.number), {description: "Publication timestamp"});
    
    static byAuthor = E.unique(Post, ["author", "title"]);
}


function noNeedToRunThis() {
    // Verify that TypeScript errors pop up in all the right places and not in the wrong places.

    // @ts-expect-error
    new Person({name: "x", age: "Str"});

    let p = new Person({name: "x", age: 42});
    p.age = 42;
    // @ts-expect-error
    p.age = "y"; // error: string is not assignable to number
    // @ts-expect-error
    p.cars = ["Toyota", "Honda", undefined, "Ford", 5]; // error: number is not assignable to string
    p.ownedData = [new Data({mode: "auto"}), new Data()];
    // @ts-expect-error
    p.ownedData = [new Data({mode: "auto"}), new Data(), 3]; // error: number is not assignable to string
    // @ts-expect-error
    p.ownedData = undefined; // error: undefined is not assignable to Data[]
    p.ownedData = [];
    // @ts-expect-error
    p.ownedData[0].mode = "wrong"; // error: "wrong" is not assignable to "auto" | "manual" | number[]
    p.ownedData[0].mode = "manual";
    p.ownedData[0].createdAt = 3;

    // @ts-expect-error
    if (p.ownedData[0].owner) p.ownedData[0].owner.name = 42; // error: number is not assignable to string
    // @ts-expect-error
    p.ownedData[0].subjects[0].ownedData[0].createdAt = "x"; // error: string is not assignable to number
    p.ownedData[0].subjects[0].ownedData[0].createdAt = 123;

}

let lastOnSaveItems: {model: Record<string,any>, change: Change}[] | undefined;
let lastOnSaveCommitId: number | undefined;

E.setOnSaveCallback((commitId, items) => {
    lastOnSaveItems = [...items].map(([model, change]) => ({model, change}));
    lastOnSaveCommitId = commitId;
});

beforeEach(async () => {
    await E.deleteEverything();
    lastOnSaveItems = undefined;
    lastOnSaveCommitId = undefined;
});


test("Checks for validity", async () => {
    await E.transact(() => {
        let p = new Person({cars: ["Toyota", "Honda", "Ford"]});
        expect(p.constructor).toBe(Person);
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
        // @ts-expect-error
        p.cars = ["Toyota", "Honda", undefined, "Ford", 5];
        expect(p.isValid()).toBe(false);
        p.cars = ["Toyota", "Honda", "Ford"];
        expect(p.isValid()).toBe(true);

        // @ts-expect-error
        p.age = "y";
        expect(p.isValid()).toBe(false);
        p.age = 42;
        expect(p.isValid()).toBe(true);
    });

    await E.transact(() => {
        const p = Person.pk.get("Frank");
        expect(p).toBeDefined();
        expect(p!.name).toBe("Frank");
        expect(p!.age).toBe(42);
        expect(p!.cars).toEqual(["Toyota", "Honda", "Ford"]);
    });
})

test("Sets defaults", async () => {

    @E.registerModel
    class Defaults extends E.Model<Defaults> {
        // @ts-expect-error
        first = E.field(E.string, {default: 3});
        // @ts-expect-error
        last = E.field(E.string, {default: () => 3});
        role = E.field(E.string, {default: () => "CEO"});
        tags = E.field(E.array(E.number), {default: () => [12, 5]})
        userName = E.field(E.string, {default: obj => `${obj.first}${obj.last[0]||''}`.toLowerCase()})
    }

    await E.transact(() => {
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
        e.preventPersist();
    });
})

test("Boolean type validation", async () => {
    @E.registerModel
    class Settings extends E.Model<Settings> {
        enabled = E.field(E.boolean, {description: "Feature toggle"});
    }

    await E.transact(() => {
        let s = new Settings({enabled: true});
        expect(s.isValid()).toBe(true);

        // @ts-expect-error
        s.enabled = "true";
        expect(s.isValid()).toBe(false);

        s.enabled = false;
        expect(s.isValid()).toBe(true);
    });
})

test("Model persistence", async () => {
    @E.registerModel
    class TestModel extends E.Model<TestModel> {
        id = E.field(E.number);
        name = E.field(E.string);
        flag = E.field(E.boolean, {default: false});
        static pk = E.primary(TestModel, ["id"]);
    }

    await E.transact(async () => {
        new TestModel({id: 1, name: "test"});
    });

    await E.transact(() => {
        const loaded = TestModel.pk.get(1);
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("test");
        expect(loaded!.flag).toBe(false);
    });

    await E.transact(() => {
        const loaded = TestModel.findAll().fetch();
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("test");
        expect(loaded!.flag).toBe(false);
    });    

    // Test loading non-existent model
    const notFound = await E.transact(() => TestModel.pk.get(999));
    expect(notFound).toBeUndefined();

    // Test loading with wrong number of primary keys
    // @ts-expect-error
    expect(() => TestModel.pk.get(1, 2)).toThrow();
})

test("Link type validation and lazy loading", async () => {
    const id = await E.transact(async () => {
        let person = new Person({name: "Frank", cars: ["Toyota", "Honda"]});

        return (new Data({
            mode: "auto",
            createdAt: 123456,
            subjects: [person]
        })).id;
    });

    // Test loading
    await E.transact(async () => {
        const loadedData = await Data.findAll().fetch();
        expect(loadedData).toBeDefined();
        expect(loadedData!.id).toBe(id);
        expect(loadedData!.mode).toBe("auto");
        expect(loadedData!.createdAt).toBe(123456);
        expect(loadedData!.subjects.length).toBe(1);
        expect(loadedData!.subjects[0].name).toBe("Frank");

        // The subjects[0] should still not have been loaded at this point
        expect(loadedData!.subjects[0].isLazyField('name')).toBe(false);
        expect(loadedData!.subjects[0].isLazyField('age')).toBe(true);

        // Now trigger the lazy loading
        expect(loadedData!.subjects[0].age).toBe(42);
        expect(loadedData!.subjects[0].isLazyField('age')).toBe(false);

        
        const data = new Data();
        // @ts-expect-error - Wrong type
        loadedData!.subjects = [data];
        expect(loadedData!.isValid()).toBe(false);
        data!.preventPersist();
        loadedData!.preventPersist();
    });
})

test("Invalid data must throw on save", async () => {
    await expectErrorCode("OUT_OF_BOUNDS", () => E.transact(async () => {
        new Data({createdAt: 1234}); // subjects is implicitly empty, but must be at least 1
    }));
});

test("Update a lazy-loaded row", async () => {
    await E.transact(async () => {
        new Simple({value: 1234});
    });

    await E.transact(async () => {
        const simple = Simple.byValue.find({is: 1234}).fetch();
        expect(simple).toBeDefined();
        expect(simple!.isLazyField('id')).toBe(false); // Primary key must be loaded
        expect(simple!.isLazyField('value')).toBe(false); // As well as fields in this index
        expect(simple!.isLazyField('name')).toBe(true); // Other fields are lazy
        simple!.value = 4321;
    });

    await E.transact(async () => {
        const simple = Simple.findAll().fetch();
        expect(simple).toBeDefined();
        expect(simple!.value).toBe(4321);
    });

    await E.transact(async () => {
        const simple = Simple.byValue.find({is: 4321}).fetch();
        expect(simple).toBeDefined();
        expect(simple!.value).toBe(4321);

        expect(simple!.isLazyField('value')).toBe(false);
        expect(simple!.isLazyField('name')).toBe(true);
    });

});

test("Parallel transactions", async () => {
    // Multiple transactions should be able to run concurrently
    const results = await Promise.all([
        E.transact(() => {
            const user = new User({email: "parallel1@test.com", name: "Parallel 1"});
            return user.id;
        }),
        E.transact(() => {
            const user = new User({email: "parallel2@test.com", name: "Parallel 2"});
            return user.id;
        }),
        E.transact(() => {
            const user = new User({email: "parallel3@test.com", name: "Parallel 3"});
            return user.id;
        }),
    ]);

    expect(results).toHaveLength(3);
    expect(new Set(results).size).toBe(3); // All different IDs

    // Verify all were persisted
    await E.transact(() => {
        for (const id of results) {
            expect(User.pk.get(id)).toBeDefined();
        }
    });
});

test("Type system comprehensive validation", async () => {
    @E.registerModel
    class TypeTest extends E.Model<TypeTest> {
        static pk = E.primary(TypeTest, ["id"]);
        
        id = E.field(E.identifier);
        literalString = E.field(E.literal("fixed"), {description: "Fixed string literal"});
        literalNumber = E.field(E.literal(42), {description: "Fixed number literal"});
        literalNull = E.field(E.literal(null), {description: "Null literal"});
        literalUndefined = E.field(E.literal(undefined), {description: "Undefined literal"});
        unionType = E.field(E.or(E.string, E.number, E.literal("special")), {description: "Union type", default: "test"});
        optionalString = E.field(E.opt(E.string), {description: "Optional string"});
        boundedArray = E.field(E.array(E.string, {min: 1, max: 3}), {description: "Bounded array"});
        nestedArray = E.field(E.array(E.array(E.number)), {description: "Nested array"});
    }

    await E.transact(() => {
        const t = new TypeTest();
        
        // Test basic literal values - they should initialize to their literal values
        expect(t.literalString).toBe("fixed");
        expect(t.literalNumber).toBe(42);
        expect(t.literalNull).toBe(null);  // BUG: Currently returns undefined
        expect(t.literalUndefined).toBe(undefined);
        
        // Model should be invalid initially because arrays without defaults are undefined
        expect(t.isValid()).toBe(false);
        
        // Fix required fields to make model valid
        t.boundedArray = ["one"];
        t.nestedArray = [[1, 2]];
        expect(t.isValid()).toBe(true);
        
        // Test union type validation
        t.unionType = "string value";
        expect(t.isValid()).toBe(true);
        
        t.unionType = 123;
        expect(t.isValid()).toBe(true);
        
        t.unionType = "special";
        expect(t.isValid()).toBe(true);
        
        // @ts-expect-error - Invalid union value
        t.unionType = true;
        expect(t.isValid()).toBe(false);
        
        // Reset to valid value
        t.unionType = "valid";
        
        // Test optional type
        t.optionalString = undefined;
        expect(t.isValid()).toBe(true);
        
        t.optionalString = "defined";
        expect(t.isValid()).toBe(true);
        
        // @ts-expect-error - Wrong type for optional
        t.optionalString = 123;
        expect(t.isValid()).toBe(false);
        
        // Reset to valid
        t.optionalString = "valid";
        
        // Test array bounds validation
        t.boundedArray = ["one"];
        expect(t.isValid()).toBe(true);
        
        t.boundedArray = ["one", "two", "three"];
        expect(t.isValid()).toBe(true);
        
        // Empty array should be invalid (min: 1)
        t.boundedArray = [];
        expect(t.isValid()).toBe(false);
        
        // Too many items should be invalid (max: 3)
        t.boundedArray = ["one", "two", "three", "four"];
        expect(t.isValid()).toBe(false);
        
        // Reset to valid
        t.boundedArray = ["valid"];
        
        // Test nested arrays
        t.nestedArray = [[1, 2], [3, 4]];
        expect(t.isValid()).toBe(true);
        
        // @ts-expect-error - Wrong nested type
        t.nestedArray = [[1, 2], ["string", 4]];
        expect(t.isValid()).toBe(false);
        t.nestedArray = [[1, 2], [3, 4]]; // Reset
        
        // Test literal field modification - should fail validation
        // @ts-expect-error
        t.literalString = "wrong";
        expect(t.isValid()).toBe(false);
        t.literalString = "fixed"; // Reset
        
        // @ts-expect-error
        t.literalNumber = 99;
        expect(t.isValid()).toBe(false);
        t.literalNumber = 42; // Reset
        
        // @ts-expect-error
        t.literalNull = "not null";
        expect(t.isValid()).toBe(false);
        t.literalNull = null; // Reset
        
        t.validate(true);
        expect(t.isValid()).toBe(true);
        
        t.preventPersist();
    });
});

test("Advanced model lifecycle and registration", async () => {
    // Test automatic ID field creation
    @E.registerModel
    class AutoIdModel extends E.Model<AutoIdModel> {
        name = E.field(E.string, {description: "Name field"});
    }
    
    await E.transact(() => {
        const model = new AutoIdModel({name: "test"});
        expect(typeof (model as any).id).toBe("string");
        expect((model as any).id.length).toBe(8);
        model.preventPersist();
    });

    // Test duplicate table name error
    expectErrorCode("INIT_ERROR", () => {
        @E.registerModel
        class DuplicateUser extends E.Model<DuplicateUser> {
            static tableName = "User"; // Same as existing User model
            id = E.field(E.identifier);
        }
    });

    // Test model with complex dependencies
    @E.registerModel
    class ModelA extends E.Model<ModelA> {
        static pk = E.primary(ModelA, ["id"]);
        id = E.field(E.identifier);
        bRef = E.field(E.opt(E.link(ModelB)), {description: "Reference to B"});
    }

    @E.registerModel
    class ModelB extends E.Model<ModelB> {
        static pk = E.primary(ModelB, ["id"]);
        id = E.field(E.identifier);
        aRef = E.field(E.opt(E.link(ModelA)), {description: "Reference to A"});
    }

    await E.transact(() => {
        const a = new ModelA();
        const b = new ModelB();
        a.bRef = b;
        b.aRef = a;
        expect(a.isValid()).toBe(true);
        expect(b.isValid()).toBe(true);
        a.preventPersist();
        b.preventPersist();
    });
});

test("Index system comprehensive", async () => {
    // Test composite primary key
    await E.transact(() => {
        const model = new CompositeKeyModel({
            category: "electronics",
            subcategory: "phones",
            name: "iPhone",
            value: 999
        });
        expect(model.isValid()).toBe(true);
    });

    // Test composite key loading
    await E.transact(() => {
        const loaded = CompositeKeyModel.pk.get("electronics", "phones", "iPhone");
        expect(loaded).toBeDefined();
        expect(loaded!.value).toBe(999);
    });

    // Test unique constraint violation - create in separate transaction to persist first
    await expectErrorCode("UNIQUE_CONSTRAINT", () => E.transact(() => {
        new CompositeKeyModel({
            category: "electronics",
            subcategory: "phones",
            name: "iPhone",
            value: 999 // Same value as iPhone, should violate unique constraint
        });
    }));

    // Test unique index lookup
    await E.transact(() => {
        const foundByValue = CompositeKeyModel.byValue.get(999);
        expect(foundByValue).toBeDefined();
        expect(foundByValue!.name).toBe("iPhone");
    });

    // Test loading with wrong number of primary key arguments
    expect(() => {
        // @ts-expect-error
        CompositeKeyModel.pk.get("electronics", "phones"); // Missing third argument
    }).toThrow();
});

test("Model state management and persistence", async () => {
    let userId: string;
    
    // Test basic persistence workflow
    userId = await E.transact(() => {
        const user = new User({email: "state@test.com", name: "State Test"});
        return user.id;
    });

    // Test that the user was created successfully
    await E.transact(() => {
        let loaded = User.pk.get(userId);
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("State Test");
        loaded = User.byEmail.get("state@test.com");
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("State Test");
    });

    // Test model deletion
    await E.transact(() => {
        const loaded = User.pk.get(userId);
        loaded!.delete();
    });

    // Verify deletion
    await E.transact(() => {
        let loaded = User.pk.get(userId);
        expect(loaded).toBeUndefined();
        loaded = User.byEmail.get("state@test.com");
        expect(loaded).toBeUndefined();
    });

    // Recreate the user (making sure secondary key was fully deleted)
    userId = await E.transact(() => {
        const user = new User({email: "state@test.com", name: "State Test"});
        return user.id;
    });

    // Test that the user was created successfully
    await E.transact(() => {
        let loaded = User.pk.get(userId);
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("State Test");
        loaded = User.byEmail.get("state@test.com");
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("State Test");
    });
});

test("Link relationships and bidirectional references", async () => {
    let userId: string, postId: string;

    // Create linked models
    await E.transact(() => {
        const user = new User({email: "author@test.com", name: "Author"});
        const post = new Post({
            title: "Test Post",
            content: "Test content",
            author: user,
            publishedAt: Date.now()
        });
        userId = user.id;
        postId = post.id;
    });

    // Test lazy loading
    await E.transact(() => {
        const post = Post.pk.get(postId);
        expect(post).toBeDefined();
        expect(post!.author.name).toBe("Author"); // Should lazy load
        expect(post!.author.email).toBe("author@test.com");
    });

    // Test link validation with wrong model type
    await E.transact(() => {
        const post = Post.pk.get(postId);
        // @ts-expect-error
        post!.author = new Post({title: "Wrong", content: "Type", author: post!.author});
        expect(post!.isValid()).toBe(false);
        post!.preventPersist();
    });

    // Test broken link detection
    await E.transact(() => {
        const user = User.pk.get(userId);
        user!.delete();
    });

    await E.transact(() => {
        const post = Post.pk.get(postId);
        expectErrorCode("LAZY_FAIL", () => post!.author.name); // Broken link should throw
        post!.preventPersist();
    });
});

test("Field validation comprehensive", async () => {
    @E.registerModel
    class ValidationTest extends E.Model<ValidationTest> {
        static pk = E.primary(ValidationTest, ["id"]);
        
        id = E.field(E.identifier);
        required = E.field(E.string, {description: "Required field"});
        nested = E.field(E.array(E.array(E.string)), {description: "Nested structure"});
        complex = E.field(E.or(E.string, E.array(E.number)), {description: "Complex union"});
    }

    await E.transact(() => {
        const model = new ValidationTest();
        
        // Test error aggregation
        const errors = model.validate();
        expect(errors.length).toBeGreaterThan(0);
        
        // Test specific error paths
        model.nested = [["valid"], ["also", "valid"]];
        model.complex = "string value";
        const errors2 = model.validate();
        expect(errors2.length).toBe(1); // Only required field error
        
        // Fix all errors
        model.required = "now valid";
        expect(model.isValid()).toBe(true);
        
        // Test nested validation errors with paths
        // @ts-expect-error
        model.nested = [["valid"], [123, "invalid"]];
        const errors3 = model.validate();
        expect(errors3.length).toBeGreaterThan(0);
        expect(errors3[0].message).toContain("at"); // Should contain path information
        
        model.preventPersist();
    });
});

test("Default value handling advanced", async () => {
    @E.registerModel
    class DefaultTest extends E.Model<DefaultTest> {
        static pk = E.primary(DefaultTest, ["id"]);
        
        id = E.field(E.identifier);
        staticDefault = E.field(E.string, {default: "static", description: "Static default"});
        functionDefault = E.field(E.string, {default: () => "generated", description: "Function default"});
        contextDefault = E.field(E.string, {default: (obj) => `context-${obj.id}`, description: "Context default"});
        arrayDefault = E.field(E.array(E.string), {default: () => ["initial"], description: "Array default"});
    }

    await E.transact(() => {
        const model1 = new DefaultTest();
        const model2 = new DefaultTest();
        
        // Test static defaults
        expect(model1.staticDefault).toBe("static");
        expect(model2.staticDefault).toBe("static");
        
        // Test function defaults
        expect(model1.functionDefault).toBe("generated");
        expect(model2.functionDefault).toBe("generated");
        
        // Test context-based defaults
        expect(model1.contextDefault).toBe(`context-${model1.id}`);
        expect(model2.contextDefault).toBe(`context-${model2.id}`);
        expect(model1.contextDefault).not.toBe(model2.contextDefault);
        
        // Test array default isolation
        model1.arrayDefault.push("added1");
        model2.arrayDefault.push("added2");
        expect(model1.arrayDefault).toEqual(["initial", "added1"]);
        expect(model2.arrayDefault).toEqual(["initial", "added2"]);
        
        model1.preventPersist();
        model2.preventPersist();
    });
});

test("Modification tracking and proxy behavior", async () => {
    await E.transact(() => {
        const user = new User({email: "proxy@test.com", name: "Proxy Test"});
        
        // Test nested object modification tracking
        user.posts = [];
        const post = new Post({
            title: "Nested Test",
            content: "Content",
            author: user
        });
        user.posts.push(post);
        
        // Verify proxy wrapping of nested objects
        expect(user.posts).toBeDefined();
        expect(user.posts[0]).toBe(post);
        
        // Test modification detection on nested arrays
        user.posts[0].tags.push("tag1");
        user.posts[0].tags.push("tag2");
        expect(user.posts[0].tags).toEqual(["tag1", "tag2"]);
        
        // Test that changes persist (indicating modification tracking works)
        user.preventPersist();
        post.preventPersist();
    });

    // Verify the modifications were tracked by checking persistence
    await E.transact(() => {
        const user = new User({email: "track@test.com", name: "Track Test"});
        const initialName = user.name;
        user.name = "Changed Name";
        // Don't call preventPersist - let it save
        return user.id;
    });

    // Verify the change was persisted (proving modification tracking worked)
    await E.transact(() => {
        const loaded = User.byEmail.get("track@test.com");
        expect(loaded).toBeDefined();
        expect(loaded!.name).toBe("Changed Name");
    });
});

test("Error handling and recovery", async () => {
    // Test validation error with proper error codes
    @E.registerModel
    class ErrorTest extends E.Model<ErrorTest> {
        static pk = E.primary(ErrorTest, ["id"]);
        
        id = E.field(E.identifier);
        numberField = E.field(E.number, {description: "Number field"});
    }

    await E.transact(() => {
        const model = new ErrorTest();
        // @ts-expect-error
        model.numberField = "not a number";
        
        expectErrorCode("INVALID_TYPE", () => model.validate(true));
        
        model.preventPersist();
    });

    // Test error recovery in transactions
    let recovered = false;
    try {
        await E.transact(() => {
            new User({email: "error@test.com", name: "Error Test"});
            throw new Error("Simulated error");
        });
    } catch (error) {
        recovered = true;
    }
    expect(recovered).toBe(true);
    
    // Verify transaction was rolled back
    await E.transact(() => {
        const user = User.byEmail.get("error@test.com");
        expect(user).toBeUndefined();
    });
});

test("Database operations and debugging", async () => {
    // Test database dump functionality
    await E.transact(() => {
        new User({email: "dump@test.com", name: "Dump Test"});
    });

    // Test dump doesn't crash and produces output by mocking console.log
    const originalConsoleLog = console.log;
    const logSpy: string[] = [];
    console.log = (...args: any[]) => {
        logSpy.push(args.join(' '));
    };

    try {
        await E.transact(() => {
            E.dump();
            // Verify dump produced output
            expect(logSpy.length).toBeGreaterThan(0);
        });
    } finally {
        // Restore original console.log
        console.log = originalConsoleLog;
    }

    // Test database state after operations
    await E.transact(() => {
        const user = User.byEmail.get("dump@test.com");
        expect(user).toBeDefined();
        expect(user!.name).toBe("Dump Test");
    });

    // Test concurrent model access patterns
    const userIds: string[] = [];
    for (let i = 0; i < 5; i++) {
        const userId = await E.transact(() => {
            const user = new User({
                email: `concurrent${i}@test.com`,
                name: `Concurrent ${i}`
            });
            return user.id;
        });
        userIds.push(userId);
    }
    
    expect(userIds).toHaveLength(5);
    expect(new Set(userIds).size).toBe(5); // All unique IDs
    
    // Verify all users were created
    await E.transact(() => {
        for (let i = 0; i < 5; i++) {
            const user = User.byEmail.get(`concurrent${i}@test.com`);
            expect(user).toBeDefined();
            expect(user!.name).toBe(`Concurrent ${i}`);
        }
    });
});

test("Range queries on primary indices", async () => {
    // Create test data in one transaction
    await E.transact(() => {
        // Insert something in an unrelated table with a lower indexId
        const user = new User({email: "a@test.com", name: "A"});
        new CompositeKeyModel({category: "electronics", subcategory: "phones", name: "iPhone", value: 999});
        new CompositeKeyModel({category: "electronics", subcategory: "phones", name: "Samsung", value: 799});
        new CompositeKeyModel({category: "electronics", subcategory: "tablets", name: "iPad", value: 1299});
        new CompositeKeyModel({category: "electronics", subcategory: "tablets", name: "Surface", value: 1099});
        new CompositeKeyModel({category: "electronics", subcategory: "laptops", name: "MacBook", value: 1999});
        new CompositeKeyModel({category: "electronics", subcategory: "watches", name: "AppleWatch", value: 599});
        // Insert something in an unrelated table with a higher indexId
        new Post({title: "Post 1", content: "Content 1", author: user});
    });

    // Test in a separate transaction after models are saved
    await E.transact(() => {
        // Inclusive
        let values: number[] = [];
        let items = CompositeKeyModel.pk.find({from: ["electronics", "phones", "iPhone"], to: ["electronics", "tablets", "iPad"]});
        for(const item of items) {
            values.push(item.value);
        }
        expect(values).toEqual([999, 1099, 1299]); // iPhone, Surface, iPad (in lexicographic order)

        // Exclusive
        values = [];
        items = CompositeKeyModel.pk.find({from: ["electronics", "phones", "iPhone"], before: ["electronics", "tablets", "iPad"]});
        for(const item of items) {
            values.push(item.value);
        }
        expect(values).toEqual([999, 1099]); // iPhone, Surface (excludes iPad, lexicographic order)        
    });

    // Test with no bounds (all electronics)
    await E.transact(() => {
        let allElectronics: number[] = [];
        const items = CompositeKeyModel.pk.find();
        for(const item of items) {
            allElectronics.push(item.value);
        }
        expect(allElectronics).toEqual([1999, 799, 999, 1099, 1299, 599]); // lexicographic order
    });

    // Test single bound (from start to iPad)
    await E.transact(() => {
        let fromStart: number[] = [];
        const items = CompositeKeyModel.pk.find({to: ["electronics", "tablets", "iPad"]});
        for(const item of items) {
            fromStart.push(item.value);
        }
        expect(fromStart).toEqual([1999, 799, 999, 1099, 1299]); // MacBook, Samsung, iPhone, Surface, iPad
    });

    // Test single bound (from iPad to end)
    await E.transact(() => {
        let toEnd: number[] = [];
        const items = CompositeKeyModel.pk.find({from: ["electronics", "tablets", "iPad"]});
        for(const item of items) {
            toEnd.push(item.value);
        }
        expect(toEnd).toEqual([1299, 599]); // iPad, AppleWatch
    });
});

test("Range queries on unique indices", async () => {
    function testRange() {
        let names: string[] = [];
        const users = User.byEmail.find({from: "b@test.com", to: "f@test.com"});
        for(const user of users) {
            names.push(user.name);
        }
        expect(names.sort()).toEqual(["B", "C", "D", "E", "F"]);
    }

    function testExclusiveRange() {
        let names: string[] = [];
        const users = User.byEmail.find({from: "b@test.com", before: "f@test.com"});
        for(const user of users) {
            names.push(user.name);
        }
        expect(names.sort()).toEqual(["B", "C", "D", "E"]); // Excludes F
    }

    // Create test data in one transaction
    await E.transact(() => {
        new User({email: "a@test.com", name: "A"});
        new User({email: "c@test.com", name: "C"});
        new User({email: "d@test.com", name: "D"});
        new User({email: "e@test.com", name: "E"});
        new User({email: "g@test.com", name: "G"});
        new User({email: "b@test.com", name: "B"});
        new User({email: "f@test.com", name: "F"});
        new User({email: "i@test.com", name: "I"});
        new User({email: "h@test.com", name: "H"});
    });

    // Test in a separate transaction after models are saved
    await E.transact(() => {
        testRange();
        testExclusiveRange();
    });

    // Test it again within a new transaction
    await E.transact(() => {
        testRange();
        testExclusiveRange();
    });

    // Test with no bounds (all users)
    await E.transact(() => {
        let allNames: string[] = [];
        const users = User.byEmail.find({});
        for(const user of users) {
            allNames.push(user.name);
        }
        expect(allNames.sort()).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I"]);
    });

    // Test single bound (from start)
    await E.transact(() => {
        let fromStart: string[] = [];
        const users = User.byEmail.find({to: "d@test.com"});
        for(const user of users) {
            fromStart.push(user.name);
        }
        expect(fromStart.sort()).toEqual(["A", "B", "C", "D"]);
    });

    // Test single bound (to end)
    await E.transact(() => {
        let toEnd: string[] = [];
        const users = User.byEmail.find({from: "f@test.com"});
        for(const user of users) {
            toEnd.push(user.name);
        }
        expect(toEnd.sort()).toEqual(["F", "G", "H", "I"]);
    });

    // Test exact match behavior
    await E.transact(() => {
        let exactMatch: string[] = [];
        const users = User.byEmail.find({is: "d@test.com"});
        for(const user of users) {
            exactMatch.push(user.name);
        }
        expect(exactMatch.sort()).toEqual(["D"]);
    });
});

test("Secondary index implementation", async () => {
    // Create a test model with secondary indexes
    @E.registerModel
    class Product extends E.Model<Product> {
        static pk = E.primary(Product, ["id"]);
        
        id = E.field(E.identifier, {description: "Product ID"});
        name = E.field(E.string, {description: "Product name"});
        price = E.field(E.number, {description: "Product price"});
        category = E.field(E.string, {description: "Product category"});
        inStock = E.field(E.boolean, {description: "In stock status", default: true});
        
        // Secondary indexes
        static byPrice = E.index(Product, "price");
        static byCategory = E.index(Product, "category");
        static byCategoryPrice = E.index(Product, ["category", "price"]);
        static byStock = E.index(Product, "inStock");
        static byName = E.unique(Product, "name");
    }

    // Test that secondary indexes don't have get() method (compile-time check)
    // This should not compile: Product.byPrice.get(1000);
    
    // Create test data in first transaction
    await E.transact(() => {
        new Product({name: "Laptop", price: 1000, category: "electronics"});
        new Product({name: "Phone", price: 800, category: "electronics"});
        new Product({name: "Tablet", price: 600, category: "electronics"});
        new Product({name: "Chair", price: 200, category: "furniture"});
        new Product({name: "Desk", price: 500, category: "furniture"});
        new Product({name: "Book", price: 20, category: "books", inStock: false});
        new Product({name: "Notebook", price: 15, category: "books"});
    });

    // Test single-field secondary index queries in separate transaction
    await E.transact(() => {
        // Find products by price
        const expensiveProducts: string[] = [];
        for (const product of Product.byPrice.find({from: 500})) {
            expensiveProducts.push(product.name);
        }
        expect(expensiveProducts.sort()).toEqual(["Desk", "Laptop", "Phone", "Tablet"]);

        // Find products in specific price range
        const midRangeProducts: string[] = [];
        for (const product of Product.byPrice.find({from: 200, to: 600})) {
            midRangeProducts.push(product.name);
        }
        expect(midRangeProducts.sort()).toEqual(["Chair", "Desk", "Tablet"]);

        // Find products by category
        const electronicsProducts: string[] = [];
        for (const product of Product.byCategory.find({is: "electronics"})) {
            electronicsProducts.push(product.name);
        }
        expect(electronicsProducts.sort()).toEqual(["Laptop", "Phone", "Tablet"]);

        // Find out of stock products
        const outOfStockProducts: string[] = [];
        for (const product of Product.byStock.find({is: false})) {
            outOfStockProducts.push(product.name);
        }
        expect(outOfStockProducts).toEqual(["Book"]);
    });

    // Test multi-field secondary index queries
    await E.transact(() => {
        // Find electronics under $700
        const cheapElectronics: string[] = [];
        for (const product of Product.byCategoryPrice.find({from: ["electronics"], to: ["electronics", 700]})) {
            cheapElectronics.push(product.name);
        }
        expect(cheapElectronics.sort()).toEqual(["Tablet"]);

        // Find all furniture
        const furnitureProducts: Array<{name: string, price: number}> = [];
        for (const product of Product.byCategoryPrice.find({from: ["furniture"], to: ["furniture", Number.MAX_SAFE_INTEGER]})) {
            furnitureProducts.push({name: product.name, price: product.price});
        }
        expect(furnitureProducts.sort((a, b) => a.price - b.price)).toEqual([
            {name: "Chair", price: 200},
            {name: "Desk", price: 500}
        ]);

        // Find books with exact category match
        const bookProducts: string[] = [];
        for (const product of Product.byCategoryPrice.find({is: ["books"]})) {
            bookProducts.push(product.name);
        }
        expect(bookProducts.sort()).toEqual(["Book", "Notebook"]);
    });

    // Test range queries with reverse iteration
    await E.transact(() => {
        const productsByPriceDesc: string[] = [];
        for (const product of Product.byPrice.find({reverse: true})) {
            productsByPriceDesc.push(`${product.name}(${product.price})`);
        }
        expect(productsByPriceDesc).toEqual([
            "Laptop(1000)", "Phone(800)", "Tablet(600)", 
            "Desk(500)", "Chair(200)", "Book(20)", "Notebook(15)"
        ]);
    });

    // Modify an item's price: 800 -> 799, updating one index and leaving the rest unchanged
    await E.transact(() => {
        let cnt = 0;
        for (const product of Product.byPrice.find({is: 800})) {
            product.price--;
            cnt++;
        }
        expect(cnt).toBe(1);
    });

    // Verify both the changed and unchanged indices are still okay
    await E.transact(() => {
        // expect(Product.byName.get("Phone")!.price).toBe(799);
        let count = 0;
        for (const product of Product.byPrice.find({from: 790, to: 810})) {
            expect(product.price).toBe(799);
            expect(product.name).toBe("Phone");
            count++;
        }
        expect(count).toBe(1);

        expect(Product.byCategoryPrice.find({is: ["electronics", 799]}).count()).toBe(1);
        expect(Product.byCategoryPrice.find({is: ["electronics", 800]}).count()).toBe(0);

        count = 0;
        for (const product of Product.byPrice.find({from: 790, to: 810})) {
            expect(product.price).toBe(799);
            expect(product.name).toBe("Phone");
            count++;
        }
        expect(count).toBe(1);
    });

    // Test that duplicate values work correctly (non-unique nature)
    await E.transact(() => {
        // Add another product with same price
        new Product({name: "Monitor", price: 600, category: "electronics"});
    });
    
    await E.transact(() => {
        // Both products with price 600 should be found
        const products600: string[] = [];
        for (const product of Product.byPrice.find({is: 600})) {
            products600.push(product.name);
        }
        expect(products600.sort()).toEqual(["Monitor", "Tablet"]);
    });

    // Test exclusive range queries
    await E.transact(() => {
        const expensiveButNotMost: string[] = [];
        for (const product of Product.byPrice.find({after: 500, before: 1000})) {
            expensiveButNotMost.push(product.name);
        }
        expect(expensiveButNotMost.sort()).toEqual(["Monitor", "Phone", "Tablet"]);
    });

    // Test empty results
    await E.transact(() => {
        const noResults: string[] = [];
        for (const product of Product.byCategory.find({is: "nonexistent"})) {
            noResults.push(product.name);
        }
        expect(noResults).toEqual([]);

        const noResultsRange: string[] = [];
        for (const product of Product.byPrice.find({from: 2000, to: 3000})) {
            noResultsRange.push(product.name);
        }
        expect(noResultsRange).toEqual([]);
    });
});

test("throws STALE_INSTANCE on access after transaction", async () => {
    const id = await E.transact(async () => {
        let person = new User({id: 'deadbeef', name: "Frank", email: 'a@b.c'});

        return (new Post({
            title: "Test Post",
            content: "This is a test post.",
            author: person,
        })).id;
    });

    const post = await E.transact(async () => {
        return Post.pk.get(id)!;
    });

    expect(post.title).toBe("Test Post");
    expect(post.author.id).toBe('deadbeef');
    
    expectErrorCode("STALE_INSTANCE", () => post.author.name); // lazy-load outside transaction

    // It should also fail when in a new transaction
    await E.transact(() => {
        expectErrorCode("STALE_INSTANCE", () => post.author.name); // lazy-load in a different transaction
    });
});



test("onSave callback basic functionality", async () => {
    // Test CREATE operation
    const userId = await E.transact(() => {
        const user = new User({email: "callback@test.com", name: "Callback Test"});
        return user.id;
    });
    
    // Verify create callback
    expect(lastOnSaveCommitId).toBeGreaterThan(0);
    expect(lastOnSaveItems).toHaveLength(1);
    expect(lastOnSaveItems![0].model.name).toEqual("Callback Test");
    expect(lastOnSaveItems![0].change).toEqual("created");
    const initialCommitId = lastOnSaveCommitId!;
    
    // Test UPDATE operation
    await E.transact(() => {
        const user = User.pk.get(userId);
        user!.name = "Updated Name";
    });
    
    // Verify update callback
    expect(lastOnSaveCommitId).toBeGreaterThan(initialCommitId);
    expect(lastOnSaveItems).toHaveLength(1);
    expect(lastOnSaveItems![0].model.name).toEqual("Updated Name");
    expect(lastOnSaveItems![0].change).toEqual({name: "Callback Test"});
    
    // Test DELETE operation
    await E.transact(() => {
        const user = User.pk.get(userId);
        user!.delete();
    });
    
    // Verify delete callback
    expect(lastOnSaveItems).toHaveLength(1);
    expect(lastOnSaveItems![0].model.name).toEqual("Updated Name");
    expect(lastOnSaveItems![0].change).toEqual("deleted");
});

test("onSave callback with transaction rollback", async () => {
    // Test that callback is NOT called when transaction rolls back
    await expect(E.transact(() => {
        new User({email: "rollback@test.com", name: "Rollback Test"});
        throw new Error("Forced rollback");
    })).rejects.toThrow("Forced rollback");
    
    expect(lastOnSaveCommitId).toBeUndefined();

    // Verify the user was not created
    await E.transact(() => {
        expect(User.byEmail.get("rollback@test.com")).toBeUndefined();
    });
});

test("onSave callback with unique constraint failures", async () => {
    // Create first user successfully
    await E.transact(() => {
        new User({email: "unique@test.com", name: "First User"});
    });
    
    expect(lastOnSaveCommitId).toBeGreaterThan(0);
    expect(lastOnSaveItems).toHaveLength(1);
    expect(lastOnSaveItems![0].change).toBe("created");
    
    // Test constraint violation doesn't trigger callback
    await expect(E.transact(() => {
        new User({email: "bystander@test.com", name: "Bystander User"});
        new User({email: "unique@test.com", name: "Duplicate User"});
    })).rejects.toMatchObject({ code: "UNIQUE_CONSTRAINT" });
    
    // Verify only first user exists
    await E.transact(() => {
        const user = User.byEmail.get("unique@test.com");
        expect(user).toBeDefined();
        expect(user!.name).toBe("First User");
    });
});

test("onSave callback with multiple models and operations", async () => {
    let userId: string, postId: string;
    let firstCommitId: number;
    
    // Test multiple creates in one transaction
    await E.transact(() => {
        const user = new User({email: "multi@test.com", name: "Multi Test"});
        const post = new Post({
            title: "Test Post",
            content: "Test content", 
            author: user
        });
        userId = user.id;
        postId = post.id;
    });
    
    expect(lastOnSaveCommitId).toBeGreaterThan(0);
    expect(lastOnSaveItems).toHaveLength(2);
    expect(lastOnSaveItems).toEqual(
        expect.arrayContaining([
            {model: expect.objectContaining({ email: "multi@test.com" }), change: "created"},
            {model: expect.objectContaining({ title: "Test Post" }), change: "created"}
        ])
    );
    firstCommitId = lastOnSaveCommitId!;
    
    // Test multiple updates in one transaction
    await E.transact(() => {
        const user = User.pk.get(userId);
        const post = Post.pk.get(postId);
        user!.name = "Updated Multi Test";
        post!.title = "Updated Test Post";
    });
    
    expect(lastOnSaveCommitId).toBeGreaterThan(firstCommitId);
    expect(lastOnSaveItems).toHaveLength(2);
    expect(lastOnSaveItems).toEqual(
        expect.arrayContaining([
            {
                model: expect.objectContaining({ 
                    email: "multi@test.com", 
                    name: "Updated Multi Test", 
                }),
                change: {
                    name: "Multi Test"
                }
            },
            {
                model: expect.objectContaining({ 
                    title: "Updated Test Post", 
                }),
                change: {
                    title: "Test Post"
                }
            }
        ])
    );
    
    // Test mixed operations in one transaction
    await E.transact(() => {
        const user = User.pk.get(userId);
        const post = Post.pk.get(postId);
        post!.delete();
        user!.name = "Final Update";
        new User({email: "mixed@test.com", name: "Mixed Test"});
    });
    
    expect(lastOnSaveCommitId).toBeGreaterThan(firstCommitId);
    expect(lastOnSaveItems).toHaveLength(3);
    expect(lastOnSaveItems).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ change: "deleted" }),
            {model: expect.objectContaining({email: "multi@test.com"}), change: { name: "Updated Multi Test" }},
            {model: expect.objectContaining({email: "mixed@test.com"}), change: "created"}
        ])
    );
});

test("Trying to modify instances outside their transaction throws an error", async () => {
    let user: User;
    
    // Attempt to modify instance outside of a transaction
    await E.transact(() => {
        user = new User({email: "test@user.com", name: "Test User"});
    });    
    expect(() => { user.name = "Modified User"; }).toThrow();

    // Attempt to modify instance inside another transaction
    await E.transact(() => {
        user = new User({email: "test2@user.com", name: "Test User"});
    });
    await E.transact(() => {
        expect(() => { user.name = "Modified User"; }).toThrow();
    });

});

test("preCommit() is called before writes", async () => {
    @E.registerModel
    class PreCommitModel extends E.Model<PreCommitModel> {
        static pk = E.primary(PreCommitModel, "id");
        static tableName = "PreCommitModel";
        id = E.field(E.identifier);
        name = E.field(E.string);
        nameLower = E.field(E.string, {default: ""});

        preCommit() {
            this.nameLower = this.name.toLowerCase();
        }
    }

    await E.transact(() => {
        new PreCommitModel({name: "Hello World"});
    });

    await E.transact(() => {
        const m = PreCommitModel.pk.find().fetch()!;
        expect(m.nameLower).toBe("hello world");
    });
});

test("lazy migration adds a new non-key field", async () => {
    // Step 1: Register V1 model and write data
    @E.registerModel
    class LazyMigV1 extends E.Model<LazyMigV1> {
        static pk = E.primary(LazyMigV1, "id");
        static tableName = "LazyMigrateTest";
        id = E.field(E.string);
        name = E.field(E.string);
    }

    await E.transact(() => {
        new LazyMigV1({id: "row1", name: "Alice"});
        new LazyMigV1({id: "row2", name: "Bob"});
    });

    // Step 2: Register V2, overriding V1, adding a field (with default) and dropping another field
    @E.registerModel
    class LazyMigV2 extends E.Model<LazyMigV2> {
        static override = true;
        static pk = E.primary(LazyMigV2, "id");
        static tableName = "LazyMigrateTest";
        id = E.field(E.string);
        role = E.field(E.string, {default: "user"});
    }

    // Step 3: Read old rows through V2 - migrate() is called lazily on read
    await E.transact(() => {
        const r1 = LazyMigV2.pk.get("row1")!;
        expect((r1 as any).name).toBeUndefined();
        expect(r1.role).toBe("user");

        const r2 = LazyMigV2.pk.get("row2")!;
        expect((r2 as any).name).toBeUndefined();
        expect(r2.role).toBe("user");
        r2.role = "admin";
    });

    // Step 4: Register V3 with a new field without a default (but with some old rows that still have the value)
    @E.registerModel
    class LazyMigV3 extends E.Model<LazyMigV3> {
        static override = true;
        static pk = E.primary(LazyMigV3, "id");
        static tableName = "LazyMigrateTest";
        id = E.field(E.string);
        name = E.field(E.string);
        role = E.field(E.string, {default: "user"});
    }

    await E.transact(() => {
        const r1 = LazyMigV3.pk.get("row1")!;
        expect(r1.name).toBe('Alice')
        expect(r1.role).toBe("user");

        expectErrorCode("MIGRATION_ERROR", () => {
            LazyMigV3.pk.get("row2");
        });
    });
});

test("runMigration converts rows from old primary key format", async () => {
    // Step 1: Register V1 with string primary key and write rows
    @E.registerModel
    class PkConvertV1 extends E.Model<PkConvertV1> {
        static pk = E.primary(PkConvertV1, "id");
        static tableName = "PkConvertTest";
        id = E.field(E.string);
    }

    await E.transact(() => {
        new PkConvertV1({id: "1"});
        new PkConvertV1({id: "2"});
        new PkConvertV1({id: "3"});
    });

    // Step 2: Register V2 (override V1) with a numeric primary key
    @E.registerModel
    class PkConvertV2 extends E.Model<PkConvertV2> {
        static override = true;
        static pk = E.primary(PkConvertV2, "id");
        static tableName = "PkConvertTest";
        id = E.field(E.number);

        static migrate(record: Record<string, any>) {
            if (typeof record.id === "string") record.id = 10 * parseInt(record.id, 10);
        }
    }

    // Step 3: Run migration - Phase 2 should convert 3 rows to the new key format
    const result = await E.runMigration({tables: ["PkConvertTest"]});
    expect(result.primaries["PkConvertTest"]).toBe(3);

    // Step 4: Verify rows are accessible via the new numeric key
    await E.transact(() => {
        expect(PkConvertV2.pk.get(10)?.id).toBe(10);
        expect(PkConvertV2.pk.get(20)?.id).toBe(20);
        expect(PkConvertV2.pk.get(30)?.id).toBe(30);
    });
});

test("runMigration populates new secondary indexes", async () => {
    // Step 1: Register V1 model without secondary index and write data
    @E.registerModel
    class SecPopV1 extends E.Model<SecPopV1> {
        static pk = E.primary(SecPopV1, "id");
        static tableName = "SecondaryPopTest";
        id = E.field(E.string);
        category = E.field(E.string);
        score = E.field(E.number, {default: 0});
    }

    await E.transact(() => {
        new SecPopV1({id: "a", category: "x", score: 10});
        new SecPopV1({id: "b", category: "y", score: 20});
        new SecPopV1({id: "c", category: "x", score: 30});
    });

    // Step 2: Register V2 (override V1) with a new secondary index
    @E.registerModel
    class SecPopV2 extends E.Model<SecPopV2> {
        static override = true;
        static pk = E.primary(SecPopV2, "id");
        static tableName = "SecondaryPopTest";
        id = E.field(E.string);
        category = E.field(E.string);
        score = E.field(E.number, {default: 0});
        static byCategory = E.index(SecPopV2, "category");
    }

    // Step 3: Run migration - should populate the new secondary index for all 3 rows
    const result = await E.runMigration({tables: ["SecondaryPopTest"]});
    expect(result.secondaries["SecondaryPopTest"]).toBe(3);

    // Step 4: Verify the new secondary index works
    await E.transact(() => {
        const xItems = [...SecPopV2.byCategory.find({is: "x"})];
        expect(xItems.length).toBe(2);
        expect(xItems.map((i: any) => i.id).sort()).toEqual(["a", "c"]);

        const yItems = [...SecPopV2.byCategory.find({is: "y"})];
        expect(yItems.length).toBe(1);
        expect(yItems[0].id).toBe("b");
    });
});

test("runMigration fixes secondaries affected by migrate()", async () => {
    // Step 1: Register V1 with a secondary index and write data
    @E.registerModel
    class SecMigV1 extends E.Model<SecMigV1> {
        static pk = E.primary(SecMigV1, "id");
        static tableName = "SecMigrateTest";
        id = E.field(E.string);
        tag = E.field(E.string);
        static byTag = E.index(SecMigV1, "tag");
    }

    await E.transact(() => {
        new SecMigV1({id: "a", tag: "old"});
        new SecMigV1({id: "b", tag: "keep"});
    });

    // Verify initial state
    await E.transact(() => {
        expect([...SecMigV1.byTag.find({is: "old"})].length).toBe(1);
        expect([...SecMigV1.byTag.find({is: "keep"})].length).toBe(1);
    });

    // Step 2: Register V2 (override V1) with a migrate() that changes indexed tag values
    @E.registerModel
    class SecMigV2 extends E.Model<SecMigV2> {
        static override = true;
        static pk = E.primary(SecMigV2, "id");
        static tableName = "SecMigrateTest";
        id = E.field(E.string);
        tag = E.field(E.string);
        static byTag = E.index(SecMigV2, "tag");

        static migrate(record: Record<string, any>) {
            if (record.tag === "old") record.tag = "new";
        }
    }

    // Step 3: Run migration - should update the secondary index for the changed row
    const result = await E.runMigration({tables: ["SecMigrateTest"]});
    expect(result.secondaries["SecMigrateTest"]).toBe(1);
    expect(result.primaries).toEqual({}); // Primaries should be updated lazily

    // Step 4: Verify secondary index reflects migrated values
    await E.transact(() => {
        expect([...SecMigV2.byTag.find({is: "old"})].length).toBe(0);
        expect([...SecMigV2.byTag.find({is: "new"})].length).toBe(1);
        expect([...SecMigV2.byTag.find({is: "new"})][0].id).toBe("a");
        expect([...SecMigV2.byTag.find({is: "keep"})].length).toBe(1);
    });
});

test("runMigration removes orphaned secondary index entries", async () => {
    // Step 1: Register V1 with a secondary index and write data
    @E.registerModel
    class OrphanV1 extends E.Model<OrphanV1> {
        static pk = E.primary(OrphanV1, "id");
        static tableName = "OrphanedSecTest";
        id = E.field(E.string);
        tag = E.field(E.string);
        static byTag = E.index(OrphanV1, "tag");
    }

    await E.transact(() => {
        new OrphanV1({id: "a", tag: "x"});
        new OrphanV1({id: "b", tag: "y"});
    });

    // Step 2: Register V2 (override V1) without the secondary index
    @E.registerModel
    class OrphanV2 extends E.Model<OrphanV2> {
        static override = true;
        static pk = E.primary(OrphanV2, "id");
        static tableName = "OrphanedSecTest";
        id = E.field(E.string);
        tag = E.field(E.string);
    }

    // Step 3: Verify that indexes still exist on disk, by going through V1
    await E.transact(() => {
        expect(OrphanV1.byTag.find({is: "x"}).count()).toBe(1);
        expect(OrphanV1.byTag.find({is: "y"}).count()).toBe(1);
    });

    // Step 4: Run migration - Phase 3 should delete the 2 orphaned secondary index entries
    const result = await E.runMigration({tables: ["OrphanedSecTest"]});
    expect(result.orphans).toBe(2);

    // Step 5: Verify that indexes no longer exist on disk
    await E.transact(() => {
        expect(OrphanV1.byTag.find({is: "x"}).count()).toBe(0);
        expect(OrphanV1.byTag.find({is: "y"}).count()).toBe(0);
    });

    // Step 6: Verify rows are still accessible via primary key
    await E.transact(() => {
        expect(OrphanV2.pk.get("a")?.tag).toBe("x");
        expect(OrphanV2.pk.get("b")?.tag).toBe("y");
    });
});

test("preCommit() can create new instances", async () => {
    @E.registerModel
    class Parent extends E.Model<Parent> {
        static pk = E.primary(Parent, "id");
        static tableName = "PreCommitParent";
        id = E.field(E.identifier);
        name = E.field(E.string);
        preCommit() {
            // Create a child when parent is committed
            Child.replaceInto({parentId: this.id, data: this.name + "_child"});
        }
    }

    @E.registerModel
    class Child extends E.Model<Child> {
        static pk = E.primary(Child, "parentId");
        static tableName = "PreCommitChild";
        parentId = E.field(E.string);
        data = E.field(E.string);
    }

    await E.transact(() => {
        new Parent({name: "test_parent"});
    });

    // Verify child was created 
    await E.transact(() => {
        const children = [...Child.pk.find()];
        expect(children.length).toBe(1);
        expect(children[0].data).toBe("test_parent_child");
    });

    await E.transact(() => {
        const parent = [...Parent.findAll()][0];
        parent.name = 'updated_parent';
    });

    // Verify child was updated
    await E.transact(() => {
        const children = [...Child.pk.find()];
        expect(children.length).toBe(1);
        expect(children[0].data).toBe("updated_parent_child");
    });
});

test("runMigration reports no work needed for clean data", async () => {
    @E.registerModel
    class CleanModel extends E.Model<CleanModel> {
        static pk = E.primary(CleanModel, "id");
        static tableName = "CleanModel";
        id = E.field(E.string);
        tag = E.field(E.string, {default: "x"});
    }

    await E.transact(() => {
        new CleanModel({id: "a", tag: "hello"});
    });

    const result = await E.runMigration({tables: ["CleanModel"]});
    expect(result.orphans).toBe(0);
    expect(result.secondaries["CleanModel"] ?? 0).toBe(0);
});

test("Version info rows are created in the database", async () => {
    @E.registerModel
    class VersionInfoModel extends E.Model<VersionInfoModel> {
        static pk = E.primary(VersionInfoModel, "id");
        static tableName = "VersionInfoModel";
        id = E.field(E.string);
        data = E.field(E.string, {default: "x"});
    }

    await E.transact(() => {
        new VersionInfoModel({id: "test", data: "hello"});
    });

    await E.transact(() => {
        const m = VersionInfoModel.pk.get("test")!;
        expect(m.data).toBe("hello");
    });

    expect(VersionInfoModel.pk._currentVersion).toBeGreaterThan(0);
});

test("replaceInto creates a new instance when not found", async () => {
    await E.transact(() => {
        const p = Person.replaceInto({name: "ri-new-person", age: 30, cars: ["tesla"]});
        expect(p.name).toBe("ri-new-person");
        expect(p.age).toBe(30);
        expect(p.getState()).toBe("created");
    });

    // Verify it was persisted
    await E.transact(() => {
        const loaded = Person.pk.get("ri-new-person");
        expect(loaded).toBeDefined();
        expect(loaded!.age).toBe(30);
    });
});

test("replaceInto updates an existing instance", async () => {
    await E.transact(() => {
        new Person({name: "ri-exist-person", age: 10, cars: []});
    });

    await E.transact(() => {
        const p = Person.replaceInto({name: "ri-exist-person", age: 20});
        expect(p.getState()).toBe("loaded");
        expect(p.age).toBe(20);
    });

    // Verify the update was persisted
    await E.transact(() => {
        const loaded = Person.pk.get("ri-exist-person")!;
        expect(loaded.age).toBe(20);
    });
});

test("replaceInto throws when primary key fields are missing", async () => {
    await E.transact(() => {
        expect(() => Person.replaceInto({age: 5} as any)).toThrow("missing primary key");
    });
});

test("replaceInto works with composite primary keys", async () => {
    await E.transact(() => {
        new CompositeKeyModel({category: "a", subcategory: "b", name: "c", value: 1});
    });

    await E.transact(() => {
        const m = CompositeKeyModel.replaceInto({category: "a", subcategory: "b", name: "c", value: 2});
        expect(m.getState()).toBe("loaded");
        expect(m.value).toBe(2);
    });

    await E.transact(() => {
        const m = CompositeKeyModel.replaceInto({category: "a", subcategory: "b", name: "new", value: 3});
        expect(m.getState()).toBe("created");
        expect(m.value).toBe(3);
    });
});

test("batchProcess visits all rows across multiple batches", async () => {
    await E.transact(() => {
        for (let i = 0; i < 10; i++) new Simple({ value: i });
    });

    const seen: number[] = [];
    await Simple.pk.batchProcess({ limitRows: 3 }, (row) => {
        seen.push(row.value);
    });

    expect(seen).toHaveLength(10);
    expect(seen.sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
});

test("batchProcess can modify rows within batched transactions", async () => {
    await E.transact(() => {
        for (let i = 1; i <= 6; i++) new Simple({ value: i });
    });

    await Simple.pk.batchProcess({ limitRows: 2 }, (row) => {
        row.value *= 10;
    });

    const values: number[] = [];
    await E.transact(() => {
        for (const row of Simple.pk.find()) values.push(row.value);
    });
    expect(values.sort((a, b) => a - b)).toEqual([10, 20, 30, 40, 50, 60]);
});

test("batchProcess respects range options via secondary index", async () => {
    await E.transact(() => {
        for (let i = 0; i < 10; i++) new Simple({ value: i });
    });

    const seen: number[] = [];
    await Simple.byValue.batchProcess({ from: 3, to: 7, limitRows: 2 }, (row) => {
        seen.push(row.value);
    });
    expect(seen.sort((a, b) => a - b)).toEqual([3, 4, 5, 6, 7]);
});

test("Record type stores and retrieves key-value objects", async () => {
    @E.registerModel
    class Config extends E.Model<Config> {
        static pk = E.primary(Config, ["name"]);

        name = E.field(E.string);
        scores = E.field(E.record(E.number));
        metadata = E.field(E.record(E.or(E.string, E.number)));
    }

    await E.transact(() => {
        const c = new Config({ name: "test", scores: { alice: 10, bob: 20 }, metadata: { version: 1, env: "prod" } });
        expect(c.scores).toEqual({ alice: 10, bob: 20 });
        expect(c.metadata).toEqual({ version: 1, env: "prod" });
    });

    // Verify persistence across transactions
    await E.transact(() => {
        const c = Config.pk.get("test")!;
        expect(c.scores).toEqual({ alice: 10, bob: 20 });
        expect(c.metadata).toEqual({ version: 1, env: "prod" });

        // Modify and confirm
        c.scores = { charlie: 30 };
    });

    await E.transact(() => {
        const c = Config.pk.get("test")!;
        expect(c.scores).toEqual({ charlie: 30 });
    });
});

test("Record type with numeric keys", async () => {
    @E.registerModel
    class NumKeyModel extends E.Model<NumKeyModel> {
        static pk = E.primary(NumKeyModel, ["id"]);

        id = E.field(E.identifier);
        data = E.field(E.record(E.string));
    }

    await E.transact(() => {
        const m = new NumKeyModel({ data: { 1: "one", 2: "two", hello: "world" } });
        expect(m.data[1]).toBe("one");
        expect(m.data[2]).toBe("two");
        expect(m.data["hello"]).toBe("world");
    });
});

test("Record type defaults to empty object", async () => {
    @E.registerModel
    class RecDefault extends E.Model<RecDefault> {
        static pk = E.primary(RecDefault, ["id"]);

        id = E.field(E.identifier);
        tags = E.field(E.record(E.number));
    }

    await E.transact(() => {
        const r = new RecDefault();
        expect(r.tags).toEqual({});
    });
});

test("Record type validates values", async () => {
    @E.registerModel
    class RecValidation extends E.Model<RecValidation> {
        static pk = E.primary(RecValidation, ["id"]);

        id = E.field(E.identifier);
        counts = E.field(E.record(E.number));
    }

    await E.transact(() => {
        const r = new RecValidation({ counts: { a: 1, b: 2 } });
        expect(r.isValid()).toBe(true);

        // @ts-expect-error - string value for number record
        r.counts = { a: "not a number" };
        expect(r.isValid()).toBe(false);

        // @ts-expect-error - non-object value
        r.counts = "not an object";
        expect(r.isValid()).toBe(false);

        r.counts = { x: 42 };
        expect(r.isValid()).toBe(true);
    });
});

// =====================
// Computed Index Tests
// =====================

test("computed unique index: basic CRUD and get", async () => {
    @E.registerModel
    class Employee extends E.Model<Employee> {
        static override = true;
        static pk = E.primary(Employee, "id");

        id = E.field(E.identifier);
        firstName = E.field(E.string);
        lastName = E.field(E.string);

        static byFullName = E.unique(Employee, (e: Employee) => [`${e.firstName} ${e.lastName}`]);
    }

    await E.transact(() => {
        new Employee({ firstName: "John", lastName: "Doe" });
        new Employee({ firstName: "Jane", lastName: "Smith" });
    });

    await E.transact(() => {
        const john = Employee.byFullName.get("John Doe");
        expect(john).toBeDefined();
        expect(john!.firstName).toBe("John");
        expect(john!.lastName).toBe("Doe");

        const jane = Employee.byFullName.get("Jane Smith");
        expect(jane).toBeDefined();
        expect(jane!.firstName).toBe("Jane");

        expect(Employee.byFullName.get("Nobody Here")).toBeUndefined();
    });
});

test("computed unique index: unique constraint violation", async () => {
    @E.registerModel
    class UniqueComputed extends E.Model<UniqueComputed> {
        static override = true;
        static pk = E.primary(UniqueComputed, "id");

        id = E.field(E.identifier);
        a = E.field(E.string);
        b = E.field(E.string);

        static byAB = E.unique(UniqueComputed, (u: UniqueComputed) => [`${u.a}:${u.b}`]);
    }

    await E.transact(() => {
        new UniqueComputed({ a: "x", b: "y" });
    });

    await expectErrorCode("UNIQUE_CONSTRAINT", () =>
        E.transact(() => {
            new UniqueComputed({ a: "x", b: "y" });
        })
    );
});

test("computed secondary index: basic find", async () => {
    @E.registerModel
    class Product extends E.Model<Product> {
        static override = true;
        static pk = E.primary(Product, "id");

        id = E.field(E.identifier);
        price = E.field(E.number);
        category = E.field(E.string);

        static byPriceBucket = E.index(Product, (p: Product) => [Math.floor(p.price / 100)]);
    }

    await E.transact(() => {
        new Product({ price: 50, category: "A" });
        new Product({ price: 150, category: "B" });
        new Product({ price: 175, category: "C" });
        new Product({ price: 250, category: "D" });
    });

    await E.transact(() => {
        // Find all products in the $0-$99 bucket
        const bucket0 = [...Product.byPriceBucket.find({is: 0})];
        expect(bucket0.length).toBe(1);
        expect(bucket0[0].price).toBe(50);

        // Find all products in the $100-$199 bucket
        const bucket1 = [...Product.byPriceBucket.find({is: 1})];
        expect(bucket1.length).toBe(2);

        // Range query
        const buckets01 = [...Product.byPriceBucket.find({from: 0, to: 1})];
        expect(buckets01.length).toBe(3);

        // Find all
        const all = [...Product.byPriceBucket.find()];
        expect(all.length).toBe(4);
    });
});

test("computed index: undefined return skips indexing (partial index)", async () => {
    @E.registerModel
    class MaybeIndexed extends E.Model<MaybeIndexed> {
        static override = true;
        static pk = E.primary(MaybeIndexed, "id");

        id = E.field(E.identifier);
        status = E.field(E.string);
        priority = E.field(E.opt(E.number));

        static byActivePriority = E.index(MaybeIndexed, (m: MaybeIndexed) =>
            m.status === "active" ? [m.priority] : []
        );
    }

    await E.transact(() => {
        new MaybeIndexed({ status: "active", priority: 1 });
        new MaybeIndexed({ status: "active", priority: 2 });
        new MaybeIndexed({ status: "inactive", priority: 3 });
    });

    await E.transact(() => {
        // Only active items should appear in the index
        const all = [...MaybeIndexed.byActivePriority.find()];
        expect(all.length).toBe(2);

        const p1 = [...MaybeIndexed.byActivePriority.find({is: 1})];
        expect(p1.length).toBe(1);
        expect(p1[0].status).toBe("active");
    });
});

test("computed index: updates re-index on any field change", async () => {
    @E.registerModel
    class Updatable extends E.Model<Updatable> {
        static override = true;
        static pk = E.primary(Updatable, "id");

        id = E.field(E.identifier);
        x = E.field(E.number);
        y = E.field(E.number);

        static bySum = E.index(Updatable, (u: Updatable) => [u.x + u.y]);
    }

    let savedId: string;
    await E.transact(() => {
        const u = new Updatable({ x: 3, y: 4 });
        savedId = u.id;
    });

    await E.transact(() => {
        // Sum is 7
        const found7 = [...Updatable.bySum.find({is: 7})];
        expect(found7.length).toBe(1);

        // Update x, sum changes to 10
        found7[0].x = 6;
    });

    await E.transact(() => {
        const found7 = [...Updatable.bySum.find({is: 7})];
        expect(found7.length).toBe(0);

        const found10 = [...Updatable.bySum.find({is: 10})];
        expect(found10.length).toBe(1);
    });
});

test("computed index: delete removes index entries", async () => {
    @E.registerModel
    class Deletable extends E.Model<Deletable> {
        static override = true;
        static pk = E.primary(Deletable, "id");

        id = E.field(E.identifier);
        tag = E.field(E.string);

        static byTag = E.index(Deletable, (d: Deletable) => [d.tag]);
    }

    await E.transact(() => {
        new Deletable({ tag: "foo" });
        new Deletable({ tag: "foo" });
        new Deletable({ tag: "bar" });
    });

    await E.transact(() => {
        expect([...Deletable.byTag.find({is: "foo"})].length).toBe(2);

        // Delete one
        const first = [...Deletable.byTag.find({is: "foo"})][0];
        first.delete();
    });

    await E.transact(() => {
        expect([...Deletable.byTag.find({is: "foo"})].length).toBe(1);
        expect([...Deletable.byTag.find({is: "bar"})].length).toBe(1);
    });
});

test("computed unique index: find with range and reverse", async () => {
    @E.registerModel
    class Scored extends E.Model<Scored> {
        static override = true;
        static pk = E.primary(Scored, "id");

        id = E.field(E.identifier);
        name = E.field(E.string);
        score = E.field(E.number);

        static byScore = E.unique(Scored, (s: Scored) => [s.score]);
    }

    await E.transact(() => {
        new Scored({ name: "A", score: 10 });
        new Scored({ name: "B", score: 20 });
        new Scored({ name: "C", score: 30 });
        new Scored({ name: "D", score: 40 });
    });

    await E.transact(() => {
        // Range query
        const mid = [...Scored.byScore.find({from: 20, to: 30})];
        expect(mid.length).toBe(2);
        expect(mid[0].name).toBe("B");
        expect(mid[1].name).toBe("C");

        // Reverse
        const rev = [...Scored.byScore.find({reverse: true})];
        expect(rev.length).toBe(4);
        expect(rev[0].name).toBe("D");
        expect(rev[3].name).toBe("A");

        // Exclusive range
        const excl = [...Scored.byScore.find({after: 10, before: 40})];
        expect(excl.length).toBe(2);
        expect(excl[0].name).toBe("B");
        expect(excl[1].name).toBe("C");
    });
});

test("computed index: multi-value indexing", async () => {
    @E.registerModel
    class Article extends E.Model<Article> {
        static override = true;
        static pk = E.primary(Article, "id");

        id = E.field(E.identifier);
        title = E.field(E.string);

        static byWord = E.index(Article, (a: Article) => a.title.toLowerCase().split(" "));
    }

    await E.transact(() => {
        new Article({ title: "Hello World" });
        new Article({ title: "Hello There" });
        new Article({ title: "Goodbye World" });
    });

    await E.transact(() => {
        expect([...Article.byWord.find({is: "hello"})].length).toBe(2);
        expect([...Article.byWord.find({is: "world"})].length).toBe(2);
        expect([...Article.byWord.find({is: "there"})].length).toBe(1);
        expect([...Article.byWord.find({is: "goodbye"})].length).toBe(1);
    });

    // Update "Hello There" → "Greetings Everyone" (pick via "there" to be deterministic)
    await E.transact(() => {
        const target = [...Article.byWord.find({is: "there"})][0];
        target.title = "Greetings Everyone";
    });

    await E.transact(() => {
        expect([...Article.byWord.find({is: "hello"})].length).toBe(1);
        expect([...Article.byWord.find({is: "there"})].length).toBe(0);
        expect([...Article.byWord.find({is: "greetings"})].length).toBe(1);
        expect([...Article.byWord.find({is: "everyone"})].length).toBe(1);
        expect([...Article.byWord.find({is: "world"})].length).toBe(2); // unchanged
    });

    // Delete the "Greetings Everyone" article
    await E.transact(() => {
        const greet = [...Article.byWord.find({is: "greetings"})][0];
        greet.delete();
    });

    await E.transact(() => {
        expect([...Article.byWord.find({is: "greetings"})].length).toBe(0);
        expect([...Article.byWord.find({is: "everyone"})].length).toBe(0);
        expect([...Article.byWord.find({is: "world"})].length).toBe(2);
    });
});
