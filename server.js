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
// Start with empty - users will add cities as needed
const cityCoordinates = {};

// Cache for weather data
let weatherData = {};

// Function to geocode city name to coordinates using Open-Meteo Geocoding API
async function geocodeCity(cityName) {
    try {
        const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=1&language=en&format=json`;
        
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }
        
        const data = await response.json();
        
        if (data.results && data.results.length > 0) {
            const result = data.results[0];
            return {
                name: result.name,
                latitude: result.latitude,
                longitude: result.longitude,
                country: result.country || '',
                admin1: result.admin1 || '' // State/Province
            };
        }
        
        return null;
    } catch (error) {
        console.error(`Error geocoding city "${cityName}":`, error.message);
        return null;
    }
}

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
// Always sends update (even if values are the same) to trigger fade-in animations
async function updateCityWeather(city) {
    const weatherUpdate = await fetchWeatherData(city);
    if (weatherUpdate) {
        const oldData = weatherData[city];
        weatherData[city] = weatherUpdate;
        
        // WEB SOCKET MAGIC:
        // Send this update ONLY to people in this city's "room"
        // Always emit (even if same values) to trigger fade-in animations
        io.to(city).emit('temperature_update', weatherUpdate);
        
        // Log what changed
        const changes = [];
        if (oldData) {
            if (oldData.temp !== weatherUpdate.temp) changes.push(`temp: ${oldData.temp}→${weatherUpdate.temp}°C`);
            if (oldData.feelsLike !== weatherUpdate.feelsLike) changes.push(`feels: ${oldData.feelsLike}→${weatherUpdate.feelsLike}°C`);
            if (oldData.windSpeed !== weatherUpdate.windSpeed) changes.push(`wind: ${oldData.windSpeed}→${weatherUpdate.windSpeed} km/h`);
            if (oldData.humidity !== weatherUpdate.humidity) changes.push(`humidity: ${oldData.humidity}→${weatherUpdate.humidity}%`);
        }
        console.log(`Weather update for ${city}: ${changes.length > 0 ? changes.join(', ') : 'no changes (update sent for animation)'}`);
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

    // Send current cities list on connection
    socket.emit('cities_list', Object.keys(cityCoordinates));

    // 1. Listen for the client selecting a city
    socket.on('subscribe_city', async (city) => {
        if (!city || !cityCoordinates[city]) {
            socket.emit('error', `City "${city}" not found. Please select a valid city from the list.`);
            return;
        }

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

    // 2. Handle add city request
    socket.on('add_city', async (data) => {
        const { name } = data;
        
        // Validate input data
        if (!name || typeof name !== 'string' || name.trim().length === 0) {
            socket.emit('error', 'City name is required and must be a valid string');
            return;
        }
        
        const trimmedName = name.trim();

        // Check city count limit (max 3 cities)
        const currentCityCount = Object.keys(cityCoordinates).length;
        if (currentCityCount >= 3) {
            socket.emit('error', 'Maximum 3 cities allowed. Please delete a city first.');
            return;
        }

        // Check if city already exists (case-insensitive check)
        const existingCity = Object.keys(cityCoordinates).find(
            city => city.toLowerCase() === trimmedName.toLowerCase()
        );
        
        if (existingCity) {
            socket.emit('error', `City "${existingCity}" already exists. Please use a different name.`);
            return;
        }

        // Geocode the city name to get coordinates
        socket.emit('geocoding', { status: 'searching', city: trimmedName });
        const geocodeResult = await geocodeCity(trimmedName);
        
        if (!geocodeResult) {
            socket.emit('error', `Could not find coordinates for "${trimmedName}". Please check the city name and try again.`);
            return;
        }

        // Use the geocoded name (might be slightly different, e.g., "New York" -> "New York City")
        const finalCityName = geocodeResult.name;
        
        // Check again if the geocoded name already exists
        if (cityCoordinates[finalCityName]) {
            socket.emit('error', `City "${finalCityName}" already exists.`);
            return;
        }

        // Add city with geocoded coordinates
        cityCoordinates[finalCityName] = { 
            latitude: geocodeResult.latitude, 
            longitude: geocodeResult.longitude 
        };
        
        const locationInfo = geocodeResult.admin1 
            ? `${finalCityName}, ${geocodeResult.admin1}, ${geocodeResult.country}`
            : `${finalCityName}, ${geocodeResult.country}`;
        
        console.log(`City "${finalCityName}" added with coordinates (${geocodeResult.latitude}, ${geocodeResult.longitude}) - ${locationInfo}`);
        
        // Broadcast to all clients
        io.emit('city_added', finalCityName);
        io.emit('cities_list', Object.keys(cityCoordinates));
    });

    // 3. Handle delete city request
    socket.on('delete_city', (cityName) => {
        if (!cityCoordinates[cityName]) {
            socket.emit('error', `City "${cityName}" not found`);
            return;
        }

        // Allow deletion even if there are active subscribers
        // If user is subscribed to deleted city, they'll need to select another
        const rooms = io.sockets.adapter.rooms;
        const room = rooms.get(cityName);
        if (room && room.size > 0) {
            // Notify subscribers that their city was deleted
            io.to(cityName).emit('city_deleted_active', cityName);
        }

        // Delete city
        delete cityCoordinates[cityName];
        delete weatherData[cityName];
        console.log(`City "${cityName}" deleted`);
        
        // Broadcast to all clients
        io.emit('city_deleted', cityName);
        io.emit('cities_list', Object.keys(cityCoordinates));
    });

    // 4. Handle get cities request
    socket.on('get_cities', () => {
        socket.emit('cities_list', Object.keys(cityCoordinates));
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

// REAL WEATHER UPDATE LOGIC
// Fetch real weather data every 0.5 minutes (30000ms) for subscribed cities only
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
}, 30000); // 0.5 minutes

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});