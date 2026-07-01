
type Mapper<T, U> = (value: T) => U;
type MonadicMapper<T, U> = (value: T) => Maybe<U>;

class Maybe<T> {
    private constructor(private value: T | null | undefined) {}

    static some<T>(value: T): Maybe<T> {
        if (value === null || value === undefined) {
            throw new Error("Cannot create 'some' with null or undefined");
        }
        return new Maybe(value);
    }

    static none<T>(): Maybe<T> {
        return new Maybe<T>(null);
    }

    // Functor: map applies a function to the value if it exists
    map<U>(fn: Mapper<T, U>): Maybe<U> {
        if (this.value === null || this.value === undefined) {
            return Maybe.none<U>();
        }
        return Maybe.some(fn(this.value));
    }

    // Monad: flatMap applies a function that returns a Maybe, and flattens the result
    flatMap<U>(fn: MonadicMapper<T, U>): Maybe<U> {
        if (this.value === null || this.value === undefined) {
            return Maybe.none<U>();
        }
        return fn(this.value);
    }

    get(): T | null | undefined {
        return this.value;
    }
}

// --- Functor Example (map) ---
const maybeName = Maybe.some("Alice");
const upperName = maybeName.map(name => name.toUpperCase());
console.log("Functor (map) result:", upperName.get()); // ALICE

const maybeEmpty = Maybe.none<string>();
const upperEmpty = maybeEmpty.map(name => name.toUpperCase());
console.log("Functor (map) on empty result:", upperEmpty.get()); // null

// --- Monad Example (flatMap) ---
interface User {
    id: number;
    name: string;
    email?: string;
}

const users: Record<number, User> = {
    1: { id: 1, name: "Bob", email: "bob@example.com" },
    2: { id: 2, name: "Charlie" }
};

function findUserById(id: number): Maybe<User> {
    const user = users[id];
    return user ? Maybe.some(user) : Maybe.none();
}

function getUserEmail(user: User): Maybe<string> {
    return user.email ? Maybe.some(user.email) : Maybe.none();
}

// Chaining with flatMap
const user1Email = findUserById(1)
    .flatMap(getUserEmail)
    .map(email => `Email: ${email}`);
console.log("Monad (flatMap) user 1 email:", user1Email.get()); // Email: bob@example.com

const user2Email = findUserById(2)
    .flatMap(getUserEmail)
    .map(email => `Email: ${email}`);
console.log("Monad (flatMap) user 2 email:", user2Email.get()); // null (because user 2 has no email)

const user3Email = findUserById(3) // Non-existent user
    .flatMap(getUserEmail)
    .map(email => `Email: ${email}`);
console.log("Monad (flatMap) user 3 email:", user3Email.get()); // null
