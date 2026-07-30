using Npgsql;

var builder = WebApplication.CreateBuilder(args);

// ---------------------------------------------------------
// 1. Connection string
// ---------------------------------------------------------
// Read from configuration. Locally this comes from appsettings.Development.json
// (gitignored). //PROD: on your hosting platform, set this via an environment
// variable instead, e.g. ConnectionStrings__Supabase=... . Never commit a real
// connection string to git.
//
// Must be in Npgsql's keyword=value format, e.g.:
// Host=db.xxxx.supabase.co;Port=5432;Database=postgres;Username=postgres;Password=YOUR-PASSWORD;SSL Mode=Require;Trust Server Certificate=true
var connectionString = builder.Configuration.GetConnectionString("Supabase");

if (string.IsNullOrWhiteSpace(connectionString))
{
    // Fail immediately when the app starts, with a message that says exactly
    // what to do — instead of a cryptic 500 the first time an endpoint is hit.
    throw new InvalidOperationException(
        "ConnectionStrings:Supabase is missing or empty. Add it to appsettings.Development.json " +
        "(see setup-guide.md step 2.3), or set the ConnectionStrings__Supabase environment variable in production.");
}

// ---------------------------------------------------------
// 2. CORS — which frontend origins are allowed to call this API
// ---------------------------------------------------------
const string corsPolicy = "FrontendPolicy";
builder.Services.AddCors(options =>
{
    options.AddPolicy(corsPolicy, policy =>
    {
        policy.WithOrigins(
                "http://localhost:5500",   // e.g. VS Code "Live Server" extension
                "https://teffiha.com",
                "https://teffiha.sadikbensadi7.workers.dev/"
                // //PROD: replace the two localhost origins above with your real
                // deployed frontend domain, e.g. "https://balagh-algerie.example"
            )
            .AllowAnyHeader()
            .AllowAnyMethod();
    });
});

// Swagger UI (only wired up in Development below) — lets you test the API
// at /swagger without needing the frontend running yet.
builder.Services.AddEndpointsApiExplorer();
builder.Services.AddSwaggerGen(); // //PROD: consider disabling/protecting Swagger in production

var app = builder.Build();

if (app.Environment.IsDevelopment())
{
    app.UseSwagger();
    app.UseSwaggerUI();
}

app.UseCors(corsPolicy);

// ---------------------------------------------------------
// 3. Lookup tables: severity <-> "fireSize", service name <-> bit flag
// ---------------------------------------------------------
// incidents."fireSize" is a smallint: 1 = small, 2 = starting to get out of
// control, 3 = out of control. Index in this array + 1 = the stored value.
string[] SeverityLevels =
{
    "حريق صغير",
    "بدأ يخرج عن السيطرة",
    "خارج عن السيطرة",
};

// incidents."serviceWanted" is a single smallint storing multiple selected
// services as bit flags (so 6 checkboxes fit in one column without a join table).
(string Name, short Bit)[] ServiceFlags =
{
    ("الحماية المدنية", 1),
    ("الدرك الوطني", 2),
    ("الشرطة", 4),
    ("الإسعاف", 8),
    ("المواطنون", 16),
    ("الأطباء البيطريون", 32),
};

short? SeverityToFireSize(string severity)
{
    var index = Array.IndexOf(SeverityLevels, severity);
    return index >= 0 ? (short)(index + 1) : null;
}

string FireSizeToSeverity(short fireSize) =>
    fireSize >= 1 && fireSize <= SeverityLevels.Length ? SeverityLevels[fireSize - 1] : "غير محدد";

short EncodeServices(string[] services)
{
    short result = 0;
    foreach (var service in services)
    {
        var match = ServiceFlags.FirstOrDefault(f => f.Name == service);
        if (match.Bit != 0) result |= match.Bit;
    }
    return result;
}

string[] DecodeServices(short? serviceWanted)
{
    if (serviceWanted is null) return Array.Empty<string>();
    return ServiceFlags.Where(f => (serviceWanted.Value & f.Bit) != 0).Select(f => f.Name).ToArray();
}

// ---------------------------------------------------------
// 4. GET /incidents — list + filter
// ---------------------------------------------------------
app.MapGet("/incidents", async (short? wilaya, string? commune, string? severity, string? service) =>
{
    var sql = @"SELECT i.id, i.created_at, i.wilaya, i.commune, i.""fireSize"", i.notes,
                       i.""serviceWanted"", a.lati, a.longi
                FROM incidents i
                LEFT JOIN address a ON a.id = i.""addressId""
                WHERE 1 = 1";
    var parameters = new List<NpgsqlParameter>();

    if (wilaya.HasValue)
    {
        sql += " AND i.wilaya = @wilaya";
        parameters.Add(new NpgsqlParameter("wilaya", wilaya.Value));
    }
    if (!string.IsNullOrWhiteSpace(commune))
    {
        sql += " AND i.commune = @commune";
        parameters.Add(new NpgsqlParameter("commune", commune));
    }
    if (!string.IsNullOrWhiteSpace(severity))
    {
        var fireSize = SeverityToFireSize(severity);
        if (fireSize.HasValue)
        {
            sql += @" AND i.""fireSize"" = @fireSize";
            parameters.Add(new NpgsqlParameter("fireSize", fireSize.Value));
        }
    }
    if (!string.IsNullOrWhiteSpace(service))
    {
        var match = ServiceFlags.FirstOrDefault(f => f.Name == service);
        if (match.Bit != 0)
        {
            sql += @" AND (i.""serviceWanted"" & @bit) <> 0";
            parameters.Add(new NpgsqlParameter("bit", match.Bit));
        }
    }

    // //PROD: add real pagination (LIMIT/OFFSET or keyset) once the table grows large.
    sql += " ORDER BY i.created_at DESC LIMIT 200";

    await using var conn = new NpgsqlConnection(connectionString);
    await conn.OpenAsync();
    await using var cmd = new NpgsqlCommand(sql, conn);
    cmd.Parameters.AddRange(parameters.ToArray());

    var incidents = new List<object>();
    await using var reader = await cmd.ExecuteReaderAsync();

    // Read by column name (not positional index) — safer against SELECT-list reordering.
    var idOrdinal = reader.GetOrdinal("id");
    var createdAtOrdinal = reader.GetOrdinal("created_at");
    var wilayaOrdinal = reader.GetOrdinal("wilaya");
    var communeOrdinal = reader.GetOrdinal("commune");
    var fireSizeOrdinal = reader.GetOrdinal("fireSize");
    var notesOrdinal = reader.GetOrdinal("notes");
    var serviceWantedOrdinal = reader.GetOrdinal("serviceWanted");
    var latiOrdinal = reader.GetOrdinal("lati");
    var longiOrdinal = reader.GetOrdinal("longi");

    while (await reader.ReadAsync())
    {
        var fireSize = reader.GetInt16(fireSizeOrdinal);
        var serviceWanted = reader.IsDBNull(serviceWantedOrdinal) ? (short?)null : reader.GetInt16(serviceWantedOrdinal);

        incidents.Add(new
        {
            id = reader.GetInt64(idOrdinal),
            createdAt = reader.GetDateTime(createdAtOrdinal),
            wilaya = reader.GetInt16(wilayaOrdinal),
            commune = reader.GetString(communeOrdinal),
            severity = FireSizeToSeverity(fireSize),
            notes = reader.IsDBNull(notesOrdinal) ? null : reader.GetString(notesOrdinal),
            services = DecodeServices(serviceWanted),
            latitude = reader.IsDBNull(latiOrdinal) ? (double?)null : reader.GetDouble(latiOrdinal),
            longitude = reader.IsDBNull(longiOrdinal) ? (double?)null : reader.GetDouble(longiOrdinal),
        });
    }

    return Results.Ok(incidents);
});

// ---------------------------------------------------------
// 5. POST /incidents — create a new report (JSON body)
// ---------------------------------------------------------
app.MapPost("/incidents", async (IncidentRequest body) =>
{
    // ---- Basic validation (mirrors script.js; the API must not trust the browser alone) ----
    if (body.Wilaya is < 1 or > 58)
        return Results.BadRequest(new { error = "A valid wilaya code (1-58) is required" });

    if (string.IsNullOrWhiteSpace(body.Commune))
        return Results.BadRequest(new { error = "commune is required" });

    var fireSize = SeverityToFireSize(body.Severity);
    if (fireSize is null)
        return Results.BadRequest(new { error = "severity must be one of the known values" });

    if (body.Services.Any(s => ServiceFlags.All(f => f.Name != s)))
        return Results.BadRequest(new { error = "services contains an unknown value" });

    await using var conn = new NpgsqlConnection(connectionString);
    await conn.OpenAsync();

    // ---- Insert the address row first, then the incident that references it ----
    long addressId;
    await using (var addressCmd = new NpgsqlCommand(
        "INSERT INTO address (lati, longi) VALUES (@lati, @longi) RETURNING id", conn))
    {
        addressCmd.Parameters.AddWithValue("lati", body.Latitude);
        addressCmd.Parameters.AddWithValue("longi", (object?)body.Longitude ?? DBNull.Value);
        addressId = (long)(await addressCmd.ExecuteScalarAsync())!;
    }

    const string insertIncidentSql = @"
        INSERT INTO incidents (wilaya, commune, ""fireSize"", notes, ""serviceWanted"", ""addressId"")
        VALUES (@wilaya, @commune, @fireSize, @notes, @serviceWanted, @addressId)
        RETURNING id, created_at";

    await using var incidentCmd = new NpgsqlCommand(insertIncidentSql, conn);
    incidentCmd.Parameters.AddWithValue("wilaya", body.Wilaya);
    incidentCmd.Parameters.AddWithValue("commune", body.Commune);
    incidentCmd.Parameters.AddWithValue("fireSize", fireSize.Value);
    incidentCmd.Parameters.AddWithValue("notes", string.IsNullOrWhiteSpace(body.Notes) ? DBNull.Value : body.Notes);
    incidentCmd.Parameters.AddWithValue("serviceWanted", EncodeServices(body.Services));
    incidentCmd.Parameters.AddWithValue("addressId", addressId);

    await using var reader = await incidentCmd.ExecuteReaderAsync();
    await reader.ReadAsync();
    var newId = reader.GetInt64(0);
    var createdAt = reader.GetDateTime(1);

    return Results.Created($"/incidents/{newId}", new { id = newId, createdAt });
});

app.Run();

// ---------------------------------------------------------
// Request DTO — minimal APIs bind the JSON body to this automatically
// ---------------------------------------------------------
record IncidentRequest(short Wilaya, string Commune, string Severity, string? Notes, double Latitude, double? Longitude, string[] Services);