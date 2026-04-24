import * as E from "../src/edinburgh.js";

type Assert<T extends true> = T;
type IsEqual<A, B> =
    (<T>() => T extends A ? 1 : 2) extends
    (<T>() => T extends B ? 1 : 2)
        ? true
        : false;

export const DeclarationUser = E.defineModel("DeclarationUser", class {
    id = E.field(E.identifier);
    name = E.field(E.string);
}, {
    pk: "id",
});

export const DeclarationGame = E.defineModel("DeclarationGame", class {
    id = E.field(E.identifier);
    owner = E.field(E.link(DeclarationUser));
    slug = E.field(E.string);
}, {
    pk: "id",
    unique: { ownerSlug: ["owner", "slug"] },
});

export const DeclarationSearcher = E.defineModel("DeclarationSearcher", class {
    user = E.field(E.link(DeclarationUser));
    lat = E.field(E.number);
    lng = E.field(E.number);
    games = E.field(E.record(E.link(DeclarationGame)));
}, {
    pk: "user",
    index: {
        lng: "lng",
        game: s => Object.keys(s.games),
    },
});

export type DeclarationGameOwner = InstanceType<typeof DeclarationGame>["owner"];
export type DeclarationSearcherGame = InstanceType<typeof DeclarationSearcher>["games"][string];

type _ownerFieldMatchesPublicModel = Assert<IsEqual<DeclarationGameOwner, E.Model<{
    id: string;
    name: string;
}>>>;
type _searcherGameMatchesPublicModel = Assert<IsEqual<DeclarationSearcherGame, E.Model<{
    id: string;
    owner: E.Model<{
        id: string;
        name: string;
    }>;
    slug: string;
}>>>;

function compileTypeChecks() {
    const user = new DeclarationUser({ name: "D" });
    const game = new DeclarationGame({ owner: user, slug: "intro" });
    const searcher = new DeclarationSearcher({ user, lat: 1, lng: 2, games: { intro: game } });

    const owner: DeclarationGameOwner = user;
    owner.name.toUpperCase();
    game.owner = owner;
    searcher.games.intro = game;

    DeclarationGame.getBy("ownerSlug", user, "intro");
    DeclarationGame.getBy("ownerSlug", user.id, "intro");
    DeclarationGame.getBy("ownerSlug", [user.id], "intro");
    DeclarationSearcher.get(user);
    DeclarationSearcher.get(user.id);
    DeclarationSearcher.get([user.id]);

    // @ts-expect-error - linked PK shorthand must remain precise
    DeclarationGame.getBy("ownerSlug", 3, "intro");
    // @ts-expect-error - linked PK shorthand must remain precise
    DeclarationSearcher.get(3);
}

void compileTypeChecks;