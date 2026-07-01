"use strict";
class Maybe {
    value;
    constructor(value) {
        this.value = value;
    }
    static some(value) {
        if (value === null || value === undefined) {
            throw new Error("Cannot create 'some' with null or undefined");
        }
        return new Maybe(value);
    }
    static none() {
        return new Maybe(null);
    }
    // Functor: map applies a function to the value if it exists
    map(fn) {
        if (this.value === null || this.value === undefined) {
            return Maybe.none();
        }
        return Maybe.some(fn(this.value));
    }
    // Monad: flatMap applies a function that returns a Maybe, and flattens the result
    flatMap(fn) {
        if (this.value === null || this.value === undefined) {
            return Maybe.none();
        }
        return fn(this.value);
    }
    get() {
        return this.value;
    }
}
// --- Functor Example (map) ---
const maybeName = Maybe.some("Alice");
const upperName = maybeName.map(name => name.toUpperCase());
console.log("Functor (map) result:", upperName.get()); // ALICE
const maybeEmpty = Maybe.none();
const upperEmpty = maybeEmpty.map(name => name.toUpperCase());
console.log("Functor (map) on empty result:", upperEmpty.get()); // null
const users = {
    1: { id: 1, name: "Bob", email: "bob@example.com" },
    2: { id: 2, name: "Charlie" }
};
function findUserById(id) {
    const user = users[id];
    return user ? Maybe.some(user) : Maybe.none();
}
function getUserEmail(user) {
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
