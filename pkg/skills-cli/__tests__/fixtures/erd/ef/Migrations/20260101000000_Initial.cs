public partial class Initial : Migration
{
    protected override void Up(MigrationBuilder migrationBuilder)
    {
        migrationBuilder.CreateTable(
            name: "Orgs",
            columns: table => new
            {
                Id = table.Column<Guid>(type: "uniqueidentifier", nullable: false)
            },
            constraints: table => { table.PrimaryKey("PK_Orgs", x => x.Id); });
    }
}
