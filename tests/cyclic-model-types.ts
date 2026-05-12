import * as E from "../src/edinburgh.js";

export const CyclicUser = E.defineModel("CyclicUser", class {
    id = E.field(E.identifier);
    profile = E.field(E.opt(E.link(() => CyclicProfile)));
}, {
    pk: "id",
});

export const CyclicProfile = E.defineModel("CyclicProfile", class {
    id = E.field(E.identifier);
    user = E.field(E.link(CyclicUser));
}, {
    pk: "id",
    unique: { user: "user" },
});

export type CyclicUserProfile = InstanceType<typeof CyclicUser>["profile"];
export type CyclicProfileUser = InstanceType<typeof CyclicProfile>["user"];

function compileTypeChecks() {
    const user = new CyclicUser();
    const profile = new CyclicProfile({ user });

    user.profile = profile;
    profile.user = user;

    if (false) { // type checks
        profile.user.id = "123456";
        // @ts-expect-error
        profile.user.id = 123;

        profile.user.profile!.user.id = "123456";
        // @ts-expect-error
        profile.user.profile!.user.id = 123;
    }

    CyclicProfile.getBy("user", user);
    CyclicProfile.getBy("user", user.id);
    CyclicProfile.getBy("user", [user.id]);

    // @ts-expect-error - linked PK shorthand must stay precise for cyclic links too
    CyclicProfile.getBy("user", 3);
}

void compileTypeChecks;