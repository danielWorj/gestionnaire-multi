FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1
ENV PYTHONUNBUFFERED=1

WORKDIR /app

# PyMySQL est en pur Python et bcrypt/cryptography sont installes depuis des
# wheels precompiles (pas de gcc necessaire). Seules les bibliotheques de
# rendu de WeasyPrint (Pango, HarfBuzz) et une police sont requises pour les
# bulletins PDF.
RUN apt-get update \
    && apt-get install -y --no-install-recommends libpango-1.0-0 libpangoft2-1.0-0 libharfbuzz-subset0 fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 5000

CMD ["sh", "-c", "python -m flask --app app db upgrade && python -m flask --app app init-roles || true; exec gunicorn --bind 0.0.0.0:${PORT:-5000} --workers ${GUNICORN_WORKERS:-2} app:app"]