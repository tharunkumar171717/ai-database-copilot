import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../lib/generated/prisma/client";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DIRECT_URL || process.env.DATABASE_URL! }),
});

const users = [
  ["Aarav Sharma", "aarav.sharma@example.com"],
  ["Priya Patel", "priya.patel@example.com"],
  ["Rohan Mehta", "rohan.mehta@example.com"],
  ["Ananya Iyer", "ananya.iyer@example.com"],
  ["Vikram Reddy", "vikram.reddy@example.com"],
  ["Sneha Kapoor", "sneha.kapoor@example.com"],
  ["Arjun Nair", "arjun.nair@example.com"],
  ["Kavya Rao", "kavya.rao@example.com"],
  ["Rahul Verma", "rahul.verma@example.com"],
  ["Meera Joshi", "meera.joshi@example.com"],
  ["Karthik Subramanian", "karthik.s@example.com"],
  ["Divya Menon", "divya.menon@example.com"],
] as const;

// [name, price (INR), stock]
const products = [
  ["MacBook Air M3", 114900, 12],
  ["Dell XPS 15 Laptop", 189990, 4],
  ["iPhone 16", 79900, 25],
  ["Samsung Galaxy S25", 74999, 0],
  ["Sony WH-1000XM5 Headphones", 29990, 30],
  ["Apple Watch Series 10", 46900, 8],
  ["iPad Air", 59900, 0],
  ["Logitech MX Master 3S Mouse", 9995, 60],
  ["Keychron K8 Keyboard", 8499, 45],
  ["LG 27\" 4K Monitor", 32999, 10],
  ["Anker USB-C Charger 65W", 3499, 120],
  ["Samsung T7 1TB SSD", 9999, 0],
  ["JBL Flip 6 Speaker", 11999, 22],
  ["Canon EOS R50 Camera", 72990, 3],
  ["Kindle Paperwhite", 16999, 18],
] as const;

// [userIndex, productIndex, quantity, status, daysAgo]
const orders: [number, number, number, string, number][] = [
  [0, 0, 1, "delivered", 120], [0, 7, 2, "delivered", 118], [0, 10, 3, "delivered", 90],
  [0, 4, 1, "shipped", 12], [0, 8, 1, "pending", 2], [0, 14, 1, "delivered", 60],
  [1, 2, 1, "delivered", 100], [1, 5, 1, "delivered", 80], [1, 12, 2, "cancelled", 70],
  [1, 10, 2, "pending", 1], [1, 9, 1, "shipped", 8],
  [2, 1, 1, "delivered", 95], [2, 9, 2, "delivered", 94], [2, 7, 1, "pending", 3],
  [2, 3, 1, "cancelled", 40],
  [3, 2, 2, "delivered", 85], [3, 4, 2, "delivered", 50], [3, 14, 1, "shipped", 6],
  [4, 13, 1, "delivered", 75], [4, 11, 3, "delivered", 74], [4, 0, 1, "pending", 1],
  [4, 8, 2, "delivered", 30], [4, 10, 4, "delivered", 29], [4, 12, 1, "shipped", 5],
  [4, 6, 1, "delivered", 65],
  [5, 6, 1, "delivered", 110], [5, 5, 1, "cancelled", 45],
  [6, 2, 1, "delivered", 55], [6, 4, 1, "pending", 4], [6, 11, 1, "delivered", 52],
  [7, 14, 2, "delivered", 48], [7, 12, 1, "delivered", 47], [7, 7, 1, "shipped", 7],
  [8, 1, 1, "delivered", 70], [8, 3, 2, "delivered", 69], [8, 9, 1, "delivered", 68],
  [8, 10, 1, "pending", 2],
  [9, 5, 1, "delivered", 35], [9, 8, 1, "shipped", 9],
  [10, 0, 2, "delivered", 25], [10, 4, 1, "delivered", 24], [10, 13, 1, "pending", 1],
  [11, 14, 1, "delivered", 20], [11, 2, 1, "shipped", 10],
];

async function main() {
  console.log("Seeding database...");
  // Reset business tables (query_logs is left untouched).
  await prisma.order.deleteMany();
  await prisma.product.deleteMany();
  await prisma.user.deleteMany();
  await prisma.$executeRawUnsafe(
    "ALTER SEQUENCE users_id_seq RESTART WITH 1",
  );
  await prisma.$executeRawUnsafe("ALTER SEQUENCE products_id_seq RESTART WITH 1");
  await prisma.$executeRawUnsafe("ALTER SEQUENCE orders_id_seq RESTART WITH 1");

  const daysAgo = (d: number) => new Date(Date.now() - d * 24 * 60 * 60 * 1000);

  const createdUsers = [];
  for (const [i, [name, email]] of users.entries()) {
    createdUsers.push(
      await prisma.user.create({ data: { name, email, createdAt: daysAgo(200 - i * 5) } }),
    );
  }

  const createdProducts = [];
  for (const [i, [name, price, stock]] of products.entries()) {
    createdProducts.push(
      await prisma.product.create({ data: { name, price, stock, createdAt: daysAgo(180 - i * 3) } }),
    );
  }

  for (const [u, p, quantity, status, ago] of orders) {
    const unitPrice = products[p][1];
    await prisma.order.create({
      data: {
        userId: createdUsers[u].id,
        productId: createdProducts[p].id,
        quantity,
        totalAmount: unitPrice * quantity,
        status,
        createdAt: daysAgo(ago),
      },
    });
  }

  console.log(
    `Seeded ${createdUsers.length} users, ${createdProducts.length} products, ${orders.length} orders.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
