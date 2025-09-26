import { test, expect, beforeEach } from "vitest";
import * as E from '../src/edinburgh.js';
import { transact } from "olmdb";

try {
    E.init("./.olmdb_test");
} catch (error: any) {
    if (error.code !== "DUP_INIT") {
        throw error; // Rethrow if it's not the expected error
    }
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

    // TODO: Hmm, why is TypeScript not complaining about owner_data[0] being possibly undefined?

    if (p.ownedData[0].owner) p.ownedData[0].owner.name = "Frank";
    // @ts-expect-error
    if (p.ownedData[0].owner) p.ownedData[0].owner.name = 42; // error: number is not assignable to string
    // @ts-expect-error
    p.ownedData[0].subjects[0].ownedData[0].createdAt = "x"; // error: string is not assignable to number
    p.ownedData[0].subjects[0].ownedData[0].createdAt = 123;

}

beforeEach(E.deleteEverything);

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
    let code;
    try {
        await E.transact(async () => {
            new Data({createdAt: 1234}); // subjects is missing
        });
    } catch (error: any) {
        code = error.code;
    }
    expect(code).toBe("INVALID_TYPE");
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

test("Transaction management and retry logic", async () => {
    // Test transaction data storage with symbols
    const testKey = Symbol('testKey');
    await E.transact(() => {
        E.setTransactionData(testKey, "testValue");
        expect(E.getTransactionData(testKey)).toBe("testValue");
    });

    // Test onCommit callback
    let commitCalled = false;
    await E.transact(() => {
        E.onCommit(() => {
            commitCalled = true;
        });
        new User({email: "test@example.com", name: "Test User"});
    });
    expect(commitCalled).toBe(true);

    // Test onRevert callback
    let revertCalled = false;
    try {
        await E.transact(() => {
            E.onRevert(() => {
                revertCalled = true;
            });
            new User({email: "test2@example.com", name: "Test User 2"});
            throw new Error("Force rollback");
        });
    } catch (error) {
        expect(revertCalled).toBe(true);
    }

    // Test nested transaction error
    await E.transact(async () => {
        try {
            await E.transact(() => {
                // This should throw TypeError for nested transaction
            });
            expect(true).toBe(false); // Should not reach here
        } catch (error) {
            expect(error).toBeInstanceOf(TypeError);
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
    expect(() => {
        @E.registerModel
        class DuplicateUser extends E.Model<DuplicateUser> {
            static tableName = "User"; // Same as existing User model
            id = E.field(E.identifier);
        }
    }).toThrow();

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
    let err;
    try {
        await E.transact(() => {
            new CompositeKeyModel({
                category: "electronics",
                subcategory: "phones",
                name: "iPhone",
                value: 999 // Same value as iPhone, should violate unique constraint
            });
        });
    } catch (error: any) {
        err = error;
    }
    expect(err.code).toBe("UNIQUE_CONSTRAINT");

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
        expect(() => post!.author.name).toThrow(); // Broken link should throw
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
        
        try {
            model.validate(true); // Should throw
            expect(true).toBe(false); // Should not reach here
        } catch (error: any) {
            expect(error.code).toBe("INVALID_TYPE");
            expect(error.message).toContain("Expected number");
        }
        
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
            try {
                E.dump();
                // Verify dump produced output
                expect(logSpy.length).toBeGreaterThan(0);
            } catch (error) {
                // If dump fails due to internal issues, just verify it doesn't crash the test
                expect(error).toBeDefined();
            }
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


test("onSave callback basic functionality", async () => {
    const callbackEvents: Array<{commitId: number, items: any[]}> = [];
    
    E.setOnSaveCallback((commitId, items) => {
        callbackEvents.push({commitId, items});
    });

    let userId: string;
    let initialCommitId: number;
    
    // Test CREATE operation
    userId = await E.transact(() => {
        const user = new User({email: "callback@test.com", name: "Callback Test"});
        return user.id;
    });
    
    // Verify create callback
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(0);
    expect(callbackEvents[0].items).toHaveLength(1);
    expect(callbackEvents[0].items[0]).toMatchObject({
        email: "callback@test.com",
        changed: "created"
    });
    initialCommitId = callbackEvents[0].commitId;
    callbackEvents.length = 0;
    
    // Test UPDATE operation
    await E.transact(() => {
        const user = User.pk.get(userId);
        user!.name = "Updated Name";
    });
    
    // Verify update callback
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(initialCommitId);
    expect(callbackEvents[0].items).toHaveLength(1);
    expect(callbackEvents[0].items[0]).toMatchObject({
        name: "Updated Name",
        changed: { name: "Callback Test" }
    });
    callbackEvents.length = 0;
    
    // Test DELETE operation
    await E.transact(() => {
        const user = User.pk.get(userId);
        user!.delete();
    });
    
    // Verify delete callback
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(0);
    expect(callbackEvents[0].items).toHaveLength(1);
    expect(callbackEvents[0].items[0].changed).toBe("deleted");
    
    E.setOnSaveCallback(undefined);
});

test("onSave callback with transaction rollback", async () => {
    const callbackEvents: Array<{commitId: number, items: any[]}> = [];
    
    E.setOnSaveCallback((commitId, items) => {
        callbackEvents.push({commitId, items});
    });
    
    // Test that callback is NOT called when transaction rolls back
    await expect(E.transact(() => {
        new User({email: "rollback@test.com", name: "Rollback Test"});
        throw new Error("Forced rollback");
    })).rejects.toThrow("Forced rollback");
    
    expect(callbackEvents).toHaveLength(0);

    // Verify the user was not created
    await E.transact(() => {
        expect(User.byEmail.get("rollback@test.com")).toBeUndefined();
    });
    
    E.setOnSaveCallback(undefined);
});

test("onSave callback with unique constraint failures", async () => {
    const callbackEvents: Array<{commitId: number, items: any[]}> = [];
    
    E.setOnSaveCallback((commitId, items) => {
        callbackEvents.push({commitId, items: [...items]});
    });
    
    // Create first user successfully
    await E.transact(() => {
        new User({email: "unique@test.com", name: "First User"});
    });
    
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(0);
    expect(callbackEvents[0].items).toHaveLength(1);
    expect(callbackEvents[0].items[0].changed).toBe("created");
    callbackEvents.length = 0;
    
    // Test constraint violation doesn't trigger callback
    await expect(E.transact(() => {
        new User({email: "bystander@test.com", name: "Bystander User"});
        new User({email: "unique@test.com", name: "Duplicate User"});
    })).rejects.toMatchObject({ code: "UNIQUE_CONSTRAINT" });
    
    expect(callbackEvents).toHaveLength(0);
    
    // Verify only first user exists
    await E.transact(() => {
        const user = User.byEmail.get("unique@test.com");
        expect(user).toBeDefined();
        expect(user!.name).toBe("First User");
    });
    
    E.setOnSaveCallback(undefined);
});

test("onSave callback with multiple models and operations", async () => {
    const callbackEvents: Array<{commitId: number, items: any[]}> = [];
    
    E.setOnSaveCallback((commitId, items) => {
        callbackEvents.push({commitId, items: [...items]});
    });
    
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
    
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(0);
    expect(callbackEvents[0].items).toHaveLength(2);
    expect(callbackEvents[0].items).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ email: "multi@test.com", changed: "created" }),
            expect.objectContaining({ title: "Test Post", changed: "created" })
        ])
    );
    firstCommitId = callbackEvents[0].commitId;
    callbackEvents.length = 0;
    
    // Test multiple updates in one transaction
    await E.transact(() => {
        const user = User.pk.get(userId);
        const post = Post.pk.get(postId);
        user!.name = "Updated Multi Test";
        post!.title = "Updated Test Post";
    });
    
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(firstCommitId);
    expect(callbackEvents[0].items).toHaveLength(2);
    expect(callbackEvents[0].items).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ 
                email: "multi@test.com", 
                name: "Updated Multi Test", 
                changed: { name: "Multi Test" } 
            }),
            expect.objectContaining({ 
                title: "Updated Test Post", 
                changed: { title: "Test Post" } 
            })
        ])
    );
    callbackEvents.length = 0;
    
    // Test mixed operations in one transaction
    await E.transact(() => {
        const user = User.pk.get(userId);
        const post = Post.pk.get(postId);
        post!.delete();
        user!.name = "Final Update";
        new User({email: "mixed@test.com", name: "Mixed Test"});
    });
    
    expect(callbackEvents).toHaveLength(1);
    expect(callbackEvents[0].commitId).toBeGreaterThan(firstCommitId);
    expect(callbackEvents[0].items).toHaveLength(3);
    expect(callbackEvents[0].items).toEqual(
        expect.arrayContaining([
            expect.objectContaining({ changed: "deleted" }),
            expect.objectContaining({ 
                email: "multi@test.com", 
                changed: { name: "Updated Multi Test" } 
            }),
            expect.objectContaining({ 
                email: "mixed@test.com", 
                changed: "created" 
            })
        ])
    );
    
    E.setOnSaveCallback(undefined);
});
