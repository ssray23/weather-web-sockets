const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Serve static files from the public folder
app.use(express.static(path.join(__dirname, 'public')));

// City coordinates for Open-Meteo API
const cityCoordinates = {
    'London': { latitude: 51.5074, longitude: -0.1278 },
    'New York': { latitude: 40.7128, longitude: -74.0060 },
    'Tokyo': { latitude: 35.6762, longitude: 139.6503 }
};

// Cache for weather data
let weatherData = {};

// Function to fetch real weather data from Open-Meteo API
async function fetchWeatherData(city) {
    const coords = cityCoordinates[city];
    if (!coords) {
        console.error(`Coordinates not found for city: ${city}`);
        return null;
    }

    try {
        // Using Open-Meteo API (free, no API key required)
        // Fetching multiple weather parameters
        const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.latitude}&longitude=${coords.longitude}&current=temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m,relative_humidity_2m,weather_code&timezone=auto`;
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.current && data.current.temperature_2m !== undefined) {
            const current = data.current;
            return {
                city: city,
                temp: Math.round(current.temperature_2m),
                feelsLike: Math.round(current.apparent_temperature),
                precipitation: current.precipitation ? Math.round(current.precipitation * 10) / 10 : 0,
                windSpeed: Math.round(current.wind_speed_10m),
                windDirection: current.wind_direction_10m,
                humidity: current.relative_humidity_2m,
                weatherCode: current.weather_code,
                timestamp: new Date().toLocaleTimeString()
            };
        }
        
        return null;
    } catch (error) {
        console.error(`Error fetching weather for ${city}:`, error.message);
        return null;
    }
}

// Helper function to check if weather data has changed
function hasWeatherChanged(oldData, newData) {
    if (!oldData) return true; // First time, always update
    
    // Check if any field has changed
    return (
        oldData.temp !== newData.temp ||
        oldData.feelsLike !== newData.feelsLike ||
        oldData.precipitation !== newData.precipitation ||
        oldData.windSpeed !== newData.windSpeed ||
        oldData.windDirection !== newData.windDirection ||
        oldData.humidity !== newData.humidity ||
        oldData.weatherCode !== newData.weatherCode
    );
}

// Function to update weather for a specific city
async function updateCityWeather(city) {
    const weatherUpdate = await fetchWeatherData(city);
    if (weatherUpdate) {
        // Check if any weather data has changed
        if (hasWeatherChanged(weatherData[city], weatherUpdate)) {
            const oldData = weatherData[city];
            weatherData[city] = weatherUpdate;
            
            // WEB SOCKET MAGIC:
            // Send this update ONLY to people in this city's "room"
            io.to(city).emit('temperature_update', weatherUpdate);
            
            // Log what changed
            const changes = [];
            if (oldData) {
                if (oldData.temp !== weatherUpdate.temp) changes.push(`temp: ${oldData.temp}→${weatherUpdate.temp}°C`);
                if (oldData.feelsLike !== weatherUpdate.feelsLike) changes.push(`feels: ${oldData.feelsLike}→${weatherUpdate.feelsLike}°C`);
                if (oldData.windSpeed !== weatherUpdate.windSpeed) changes.push(`wind: ${oldData.windSpeed}→${weatherUpdate.windSpeed} km/h`);
                if (oldData.humidity !== weatherUpdate.humidity) changes.push(`humidity: ${oldData.humidity}→${weatherUpdate.humidity}%`);
            }
            console.log(`Weather update for ${city}: ${changes.length > 0 ? changes.join(', ') : 'initial data'}`);
        }
    }
}

// Get list of cities that have active subscribers (sockets in rooms)
function getSubscribedCities() {
    const rooms = io.sockets.adapter.rooms;
    const subscribedCities = [];
    
    for (const city of Object.keys(cityCoordinates)) {
        const room = rooms.get(city);
        if (room && room.size > 0) {
            subscribedCities.push(city);
        }
    }
    
    return subscribedCities;
}

// SOCKET CONNECTION LOGIC
io.on('connection', async (socket) => {
    console.log('A user connected:', socket.id);

    // 1. Listen for the client selecting a city
    socket.on('subscribe_city', async (city) => {
        // Leave all other rooms (cleanup) so they don't get mixed updates
        socket.rooms.forEach((room) => {
            if (room !== socket.id) socket.leave(room);
        });

        // Join the new city room
        socket.join(city);
        console.log(`Socket ${socket.id} joined room: ${city}`);

        // Fetch and send immediate current temp so they don't have to wait
        const weatherUpdate = await fetchWeatherData(city);
        if (weatherUpdate) {
            weatherData[city] = weatherUpdate;
            socket.emit('temperature_update', weatherUpdate);
        } else {
            // Fallback if API fails
            socket.emit('temperature_update', {
                city: city,
                temp: 'N/A',
                timestamp: new Date().toLocaleTimeString()
            });
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// REAL WEATHER UPDATE LOGIC
// Fetch real weather data every 5 minutes (300000ms) for subscribed cities only
// Weather doesn't change as frequently as simulated data
setInterval(async () => {
    const subscribedCities = getSubscribedCities();
    
    if (subscribedCities.length > 0) {
        console.log(`Fetching weather updates for subscribed cities: ${subscribedCities.join(', ')}`);
        for (const city of subscribedCities) {
            await updateCityWeather(city);
            // Small delay between API calls to be respectful
            await new Promise(resolve => setTimeout(resolve, 500));
        }
    } else {
        console.log('No active subscriptions, skipping weather fetch');
    }
}, 300000); // 5 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});