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
DEBUG=True
SECRET_KEY=your_secret_key_here
DATABASE_URL=your_database_url
# Add other environment variables as needed
```

### Run
```bash
python manage.py runserver
```
The application will be available at `http://localhost:8000`