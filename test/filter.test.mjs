import assert from "node:assert/strict";
import test from "node:test";
import { filterPokemon } from "../src/pokeapi.mjs";

test("filter rejects null filter parameters with a client error", async () => {
  await assert.rejects(
    filterPokemon({ type: null, generation: null }),
    (error) => {
      assert.equal(error.name, "Error");
      assert.equal(error.status, 400);
      assert.equal(error.message, "At least one filter must be provided: type or generation.");
      return true;
    }
  );
});
