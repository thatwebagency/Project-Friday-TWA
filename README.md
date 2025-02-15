# Project Friday

## Overview
Project Friday is a [brief description of your project - please replace with actual project description]. It provides [main features/capabilities of your project].

## Getting Started
Follow these steps to set up and run the project locally.

### Clone Project
```bash
git clone https://github.com/ambrosecoulter-bestdev/Project-Friday
cd project-friday
```

### Setup Environment 
```bash
python3 -m venv venv
```

### Install Requirements
```bash
pip install -r requirements.txt
```

### Initialise Database
```bash
flask db init
```

### Configure .env
Create a `.env` file in the root directory and add the following configurations:
```
WEATHER_API_KEY= #Your Weather API Key weatherapi.com
LOCATION= # e.g., "London" or "51.5074,-0.1278"
```

### Run
```bash
python3 app.py
```
The application will be available at `http://localhost:8165 or http://LOCALNETWORKIP:8165`