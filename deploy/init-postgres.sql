\getenv app_password POSTGRES_PASSWORD
CREATE ROLE omp LOGIN PASSWORD :'app_password';
ALTER DATABASE omp OWNER TO omp;
-- Administrative access uses the local socket inside the database container.
ALTER ROLE postgres PASSWORD NULL;
