## source (native)
It's from Firebase. I ran `firebase auth:export` with the Firebase CLI and saved it as CSV.

## hash-params (console)
From the Firebase console (Authentication → Users → ⋮ → Password hash parameters):

```
hash_config {
  algorithm: SCRYPT,
  base64_signer_key: {{env:FIREBASE_HASH_SIGNER_KEY}},
  base64_salt_separator: {{env:FIREBASE_HASH_SALT_SEPARATOR}},
  rounds: {{env:FIREBASE_HASH_ROUNDS}},
  mem_cost: {{env:FIREBASE_HASH_MEM_COST}},
}
```
