export default {
  testEnvironment: "node",
  testMatch: ['**/build.tests/*.test.js'],
  // Run tests serially for consistency
  maxConcurrency: 1,
  maxWorkers: 1,
};
