# Use the official Node.js 22 LTS image
FROM node:22-slim

# Set the working directory inside the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json first to install dependencies
COPY package*.json ./

# Install dependencies
RUN npm install --production

# Copy the rest of your application code
COPY . .

# Expose the port your app runs on (change if needed)
EXPOSE 3000

# Start the application
CMD ["node", "index.js"]
