import { createClerkClient } from "@clerk/backend";
const clerk = createClerkClient({ secretKey: process.env.CLERK_SECRET_KEY! });
console.log("totalCount:", await clerk.users.getCount());
const { data, totalCount } = await clerk.users.getUserList({ limit: 10 });
console.log("list totalCount:", totalCount, "returned:", data.length);
console.log(data.map((u) => u.emailAddresses[0]?.emailAddress ?? u.id));
